import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Attachment } from "@dilna/shared";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerContext } from "../container";
import { closeDb } from "../db";
import { createSessionsRoute } from "./sessions";

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
// Built in beforeAll, after DILNA_DATA_DIR points at the scratch dir
// (issue #150) — constructing at import time would bind the real dev DB.
let app: Hono;
let repoManager: ReturnType<typeof createServerContext>["repos"];
let sessionManager: ReturnType<typeof createServerContext>["sessions"];

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

	({ repos: repoManager, sessions: sessionManager } = createServerContext());
	app = new Hono().route(
		"/",
		createSessionsRoute({ sessions: sessionManager, repos: repoManager }),
	);
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

describe("attachment serving hardening (issue #222, ADR-0038)", () => {
	/** The tripwire: `text/html` is the one Content-Type that would turn this
	 * route into an XSS vector on dilna's own origin. A document is served as
	 * opaque binary no matter what MIME the row records. */
	it("never echoes a document's MIME back as an active content type", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`attach-mime-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);

		const uploaded = await upload(
			session.id,
			new File(["<script>alert(1)</script>"], "evil.html", {
				type: "text/html",
			}),
		);
		const attachment = uploaded.attachment;
		if (!attachment) throw new Error(`upload failed: ${uploaded.body}`);
		// Classified as a document, since text/html isn't in IMAGE_MIME_TYPES.
		expect(attachment.kind).toBe("document");

		const fetched = await app.request(
			`/${session.id}/attachments/${attachment.id}`,
		);
		expect(fetched.status).toBe(200);
		expect(fetched.headers.get("Content-Type")).toBe(
			"application/octet-stream",
		);
		expect(fetched.headers.get("X-Content-Type-Options")).toBe("nosniff");
		// Still downloadable under its own name — hardening, not removal.
		expect(fetched.headers.get("Content-Disposition")).toContain("evil.html");

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	}, 60_000);
});

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

		// Issue #222/ADR-0038: an Agent can mint attachment rows now, so these
		// bytes may be model-chosen and are served inline from dilna's own
		// origin. The hardening applies to user uploads too — a route whose
		// safety depends on which column a row carries is one refactor away from
		// not having it.
		expect(fetched.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(fetched.headers.get("Content-Security-Policy")).toContain(
			"default-src 'none'",
		);
		expect(fetched.headers.get("Content-Security-Policy")).toContain("sandbox");
		expect(fetched.headers.get("Referrer-Policy")).toBe("no-referrer");

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
