import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db";
import { messages as messagesTable } from "../db/schema";
import { repoManager } from "../repos/manager";
import { sessionManager } from "./manager";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

let dataDir: string;
let fixtureRepo: string;
let oldDataDir: string | undefined;

beforeAll(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;

	fixtureRepo = mkdtempSync(path.join(tmpdir(), "dilna-fixture-"));
	await git(["init", "-b", "main", fixtureRepo]);
	await git(["config", "user.email", "test@dilna.local"], { cwd: fixtureRepo });
	await git(["config", "user.name", "dilna test"], { cwd: fixtureRepo });
	writeFileSync(path.join(fixtureRepo, "README.md"), "# fixture\n");
	await git(["add", "."], { cwd: fixtureRepo });
	await git(["commit", "-m", "initial"], { cwd: fixtureRepo });
});

afterAll(() => {
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fixtureRepo, { recursive: true, force: true });
});

/** Insert the same placeholder row `beginTurn` writes at send time. */
function insertPendingPlaceholder(sessionId: string, text: string): string {
	const id = `pending-user-${sessionId}`;
	getDb()
		.insert(messagesTable)
		.values({
			id,
			sessionId,
			role: "user",
			partsJson: JSON.stringify([{ type: "text", text }]),
			createdAt: Math.floor(Date.now() / 1000) - 10,
		})
		.run();
	return id;
}

/**
 * Boot-time recovery of turns interrupted by a server death (ADR-0014,
 * hardened by ADR-0026). pi's in-process `Agent` keeps no independent record
 * of an interrupted turn beyond whatever ADR-0026's incremental persistence
 * already landed (no transcript file to backfill from, unlike Claude — an
 * accepted regression, see ADR-0020's Consequences), so `resetAllToIdle`
 * always promotes the pending placeholder rather than conditionally
 * backfilling, and always leaves a durable, visible interruption notice
 * behind (ADR-0026) — even when there was no pending placeholder to promote.
 */
describe("resetAllToIdle recovery", () => {
	it("promotes the pending placeholder to a permanent row, preserving its content, and adds an interruption notice", async () => {
		const repo = await repoManager.clone(fixtureRepo, `promote-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		const pendingId = insertPendingPlaceholder(session.id, "hello there");
		await sessionManager.setStatus(session.id, "working");

		await sessionManager.resetAllToIdle();

		expect((await sessionManager.get(session.id))?.status).toBe("idle");
		const messages = await sessionManager.getMessages(session.id);
		expect(messages).toHaveLength(2);
		const msg = messages.find((m) => m.role === "user");
		if (!msg) throw new Error("unreachable");
		// Same content, permanent id: the user's message survived the restart
		// and the stable placeholder id is free for the next turn.
		expect(msg.parts).toEqual([{ type: "text", text: "hello there" }]);
		expect(msg.id).not.toBe(pendingId);
		expect(messages.find((m) => m.role === "system")?.parts).toEqual([
			{ type: "text", text: expect.stringContaining("interrupted") },
		]);

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});

	it("still adds an interruption notice for a session with no pending placeholder", async () => {
		const repo = await repoManager.clone(fixtureRepo, `noop-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		await sessionManager.setStatus(session.id, "starting");

		await sessionManager.resetAllToIdle();

		expect((await sessionManager.get(session.id))?.status).toBe("idle");
		const messages = await sessionManager.getMessages(session.id);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("system");

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});
});
