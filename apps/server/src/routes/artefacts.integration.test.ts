import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Artefact } from "@dilna/shared";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerContext } from "../container";
import { closeDb } from "../db";
import { publishArtefact } from "../sessions/artefacts";
import { createSessionsRoute } from "./sessions";

/**
 * The artefact serve/list routes over real HTTP (issue #194, ADR-0032;
 * ADR-0043 for the non-HTML kinds), against a real DB and a real cloned Repo —
 * the same setup `attachments.integration.test.ts` uses.
 *
 * The header assertions here are the point of this file. The bytes are
 * model-generated and served from dilna's own origin, so the per-kind CSP and
 * `nosniff` are what stop a generated document from reaching the
 * unauthenticated `/api/*` surface. A refactor that drops them would look
 * harmless in review and break nothing else — these tests are the tripwire.
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
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-artefact-e2e-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;

	fixtureRepo = mkdtempSync(path.join(tmpdir(), "dilna-artefact-fixture-"));
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

/** A Session on a real Worktree, with one file published from it. */
async function sessionWithArtefact(
	content: string | Buffer,
	sourcePath = "report.html",
): Promise<{
	sessionId: string;
	artefact: Artefact;
}> {
	const repo = await repoManager.clone(fixtureRepo, `artefact-${Date.now()}`);
	const session = await sessionManager.create(repo.id);
	const full = await sessionManager.get(session.id);
	if (!full) throw new Error("session vanished");
	writeFileSync(path.join(full.worktreePath, sourcePath), content);
	const artefact = publishArtefact({
		sessionId: session.id,
		worktreePath: full.worktreePath,
		sourcePath,
		title: "Coverage report",
	});
	return { sessionId: session.id, artefact };
}

describe("artefact routes end to end", () => {
	it("serves an HTML artefact under the sandboxed, script-blocking CSP", async () => {
		const html = "<html><body><h1>Coverage</h1></body></html>";
		const { sessionId, artefact } = await sessionWithArtefact(html);

		const res = await app.request(`/${sessionId}/artefacts/${artefact.id}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(html);
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");

		const csp = res.headers.get("Content-Security-Policy") ?? "";
		// Opaque origin + nothing loadable by default: together these are what
		// deny the page same-origin access to /api/*.
		expect(csp).toContain("sandbox");
		expect(csp).toContain("default-src 'none'");
		// No script source is granted at all — scripts must not be revivable by
		// a CSP that merely forgot to mention them.
		expect(csp).not.toContain("script-src");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	/**
	 * ADR-0043's other arm. The inert kinds *must not* carry `sandbox`: it makes
	 * Chrome refuse to hand a PDF to its native viewer, so the artefact becomes a
	 * blank frame. This asserts both halves of that trade in one place — sandbox
	 * gone, `default-src 'none'` still there — because the failure mode of a
	 * "simplify the headers" refactor is dropping the CSP along with the sandbox.
	 */
	it("serves a PDF under a permissive-of-viewers but inert CSP", async () => {
		const { sessionId, artefact } = await sessionWithArtefact(
			Buffer.from("%PDF-1.4\n%%EOF"),
			"report.pdf",
		);
		expect(artefact.kind).toBe("pdf");

		const res = await app.request(`/${sessionId}/artefacts/${artefact.id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/pdf");

		const csp = res.headers.get("Content-Security-Policy") ?? "";
		expect(csp).not.toContain("sandbox");
		expect(csp).toContain("default-src 'none'");
		expect(csp).not.toContain("script-src");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("serves an image artefact inline under the inert CSP", async () => {
		const { sessionId, artefact } = await sessionWithArtefact(
			Buffer.from("89504e470d0a1a0a", "hex"),
			"chart.png",
		);
		expect(artefact.kind).toBe("image");

		const res = await app.request(`/${sessionId}/artefacts/${artefact.id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(res.headers.get("Content-Disposition")).toContain("inline");
		const csp = res.headers.get("Content-Security-Policy") ?? "";
		expect(csp).not.toContain("sandbox");
		expect(csp).toContain("default-src 'none'");
	});

	/**
	 * Markdown is served as **raw text**, never as server-rendered HTML, and as
	 * an *attachment* rather than inline. The first is the security property
	 * (ADR-0043): the web app is the only thing that turns these bytes into
	 * markup, and react-markdown escapes what it renders. The second is so
	 * "open in a new tab" shows the source rather than handing the browser a
	 * plain-text document it will happily sniff.
	 */
	it("serves markdown as raw text, as a download, under the inert CSP", async () => {
		const body = "# Report\n\n<script>alert(1)</script>\n";
		const { sessionId, artefact } = await sessionWithArtefact(body, "notes.md");
		expect(artefact.kind).toBe("markdown");

		const res = await app.request(`/${sessionId}/artefacts/${artefact.id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe(
			"text/markdown; charset=utf-8",
		);
		// The script tag comes back verbatim: nothing here sanitizes or renders
		// it, which is exactly why the client must not inject it either.
		expect(await res.text()).toBe(body);
		expect(res.headers.get("Content-Disposition")).toContain("attachment");
		const csp = res.headers.get("Content-Security-Policy") ?? "";
		expect(csp).not.toContain("sandbox");
		expect(csp).toContain("default-src 'none'");
	});

	it("lists a session's artefacts", async () => {
		const { sessionId, artefact } = await sessionWithArtefact("<p>x</p>");

		const res = await app.request(`/${sessionId}/artefacts`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { artefacts: Artefact[] };
		expect(body.artefacts).toHaveLength(1);
		expect(body.artefacts[0]?.id).toBe(artefact.id);
		expect(body.artefacts[0]?.title).toBe("Coverage report");
		// The on-disk location is server-only and must not reach the client.
		expect(body.artefacts[0]).not.toHaveProperty("path");
	});

	it("404s an artefact belonging to another session", async () => {
		const { artefact } = await sessionWithArtefact("<p>x</p>");
		const other = await sessionWithArtefact("<p>y</p>");

		const res = await app.request(
			`/${other.sessionId}/artefacts/${artefact.id}`,
		);
		expect(res.status).toBe(404);
	});

	it("404s an unknown artefact id", async () => {
		const { sessionId } = await sessionWithArtefact("<p>x</p>");
		const res = await app.request(`/${sessionId}/artefacts/does-not-exist`);
		expect(res.status).toBe(404);
	});
});
