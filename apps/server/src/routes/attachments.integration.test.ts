import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Attachment } from "@dilna/shared";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../db";
import { repoManager } from "../repos/manager";
import { sessionManager } from "../sessions/manager";
import { sessionsRoute } from "./sessions";

/**
 * The attachment flow end to end over real HTTP (issue #53): upload a file,
 * get its bytes back, and send a message that references it — against a real
 * DB and a real cloned Repo, the same way `manager.test.ts` does.
 *
 * This is the test that would catch the wiring failures unit tests can't see:
 * a multipart body the route can't parse, a `Content-Type` the browser would
 * choke on, or an id that resolves but whose bytes were never written.
 */

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

let dataDir: string;
let fixtureRepo: string;
let oldDataDir: string | undefined;
const app = new Hono().route("/", sessionsRoute);

beforeAll(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-attach-e2e-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;

	fixtureRepo = mkdtempSync(path.join(tmpdir(), "dilna-attach-fixture-"));
	await git(["init", "--initial-branch=main"], { cwd: fixtureRepo });
	await git(["config", "user.email", "test@example.com"], { cwd: fixtureRepo });
	await git(["config", "user.name", "Test"], { cwd: fixtureRepo });
	writeFileSync(path.join(fixtureRepo, "README.md"), "# fixture\n");
	await git(["add", "."], { cwd: fixtureRepo });
	await git(["commit", "-m", "initial"], { cwd: fixtureRepo });
}, 60_000);

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fixtureRepo, { recursive: true, force: true });
});

async function upload(
	sessionId: string,
	file: File,
): Promise<{ status: number; attachment?: Attachment; body: string }> {
	const form = new FormData();
	form.append("file", file);
	const res = await app.request(`/${sessionId}/attachments`, {
		method: "POST",
		body: form,
	});
	const body = await res.text();
	return {
		status: res.status,
		attachment: res.ok
			? (JSON.parse(body) as { attachment: Attachment }).attachment
			: undefined,
		body,
	};
}

describe("attachment routes end to end", () => {
	it("uploads a file, serves its bytes back, and sends a message referencing it", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`attach-e2e-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);

		const uploaded = await upload(
			session.id,
			new File([new Uint8Array([1, 2, 3, 4])], "diagram.png", {
				type: "image/png",
			}),
		);
		expect(uploaded.status).toBe(201);
		const attachment = uploaded.attachment;
		if (!attachment) throw new Error(`upload failed: ${uploaded.body}`);
		expect(attachment.kind).toBe("image");
		expect(attachment.filename).toBe("diagram.png");

		// The bytes come back byte-for-byte, with the type an <img> needs.
		const fetched = await app.request(
			`/${session.id}/attachments/${attachment.id}`,
		);
		expect(fetched.status).toBe(200);
		expect(fetched.headers.get("Content-Type")).toBe("image/png");
		expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(
			new Uint8Array([1, 2, 3, 4]),
		);

		// The send accepts the id and persists it onto the user's row. (The
		// turn itself then fails to reach a Provider in this environment, which
		// is fine — `beginTurn` has already run synchronously by the time the
		// 202 is returned.)
		const sent = await app.request(`/${session.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				text: "what's wrong here?",
				attachmentIds: [attachment.id],
			}),
		});
		expect(sent.status).toBe(202);

		const messages = await sessionManager.getMessages(session.id);
		const userRow = messages.find((m) => m.role === "user");
		expect(userRow?.parts[0]).toEqual({ type: "attachment", attachment });

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	}, 60_000);

	it("refuses an attachment id belonging to another session", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`attach-cross-${Date.now()}`,
		);
		const a = await sessionManager.create(repo.id);
		const b = await sessionManager.create(repo.id);

		const uploaded = await upload(
			a.id,
			new File([new Uint8Array([9])], "private.txt", { type: "text/plain" }),
		);
		const attachment = uploaded.attachment;
		if (!attachment) throw new Error(`upload failed: ${uploaded.body}`);

		// Not served cross-session...
		const fetched = await app.request(`/${b.id}/attachments/${attachment.id}`);
		expect(fetched.status).toBe(404);

		// ...and not sendable cross-session either.
		const sent = await app.request(`/${b.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hi", attachmentIds: [attachment.id] }),
		});
		expect(sent.status).toBe(400);

		await sessionManager.delete(a.id);
		await sessionManager.delete(b.id);
		await repoManager.delete(repo.id);
	}, 60_000);

	it("rejects a non-multipart upload with a 400", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`attach-bad-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);

		const res = await app.request(`/${session.id}/attachments`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ not: "a file" }),
		});
		expect(res.status).toBe(400);

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	}, 60_000);

	it("404s an upload to a session that doesn't exist", async () => {
		const res = await upload(
			"no-such-session",
			new File([new Uint8Array([1])], "x.txt", { type: "text/plain" }),
		);
		expect(res.status).toBe(404);
	});
});
