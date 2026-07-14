import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "../db";
import {
	messages as messagesTable,
	sessions as sessionsTable,
} from "../db/schema";
import { repoManager } from "../repos/manager";
import { sessionManager } from "./manager";

// The transcript reader is the only SDK surface boot recovery touches; mock
// it rather than hand-crafting Claude's on-disk JSONL layout (an SDK
// internal that has no compatibility contract).
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
	return { ...actual, getSessionMessages: vi.fn() };
});

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

/** Insert the same placeholder row sendMessage writes at send time. */
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

const transcriptEntry = (
	type: "user" | "assistant",
	uuid: string,
	text: string,
) => ({
	type,
	uuid,
	message: { role: type, content: [{ type: "text", text }] },
});

/**
 * Boot-time recovery of turns interrupted by a server death (ADR-0014):
 * resetAllToIdle must backfill from the agent's transcript and never delete
 * the user's message.
 */
describe("resetAllToIdle recovery", () => {
	it("backfills an interrupted turn from the transcript and drops the placeholder", async () => {
		const repo = await repoManager.clone(fixtureRepo, `recover-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		getDb()
			.update(sessionsTable)
			.set({ agentSessionId: "11111111-1111-4111-8111-111111111111" })
			.where(eq(sessionsTable.id, session.id))
			.run();
		const pendingId = insertPendingPlaceholder(session.id, "add a healthcheck");
		await sessionManager.setStatus(session.id, "working");

		vi.mocked(getSessionMessages).mockResolvedValueOnce([
			transcriptEntry("user", "u-1", "add a healthcheck"),
			transcriptEntry("assistant", "a-1", "Added it to routes."),
		] as never);

		await sessionManager.resetAllToIdle();

		expect((await sessionManager.get(session.id))?.status).toBe("idle");
		const messages = await sessionManager.getMessages(session.id);
		expect(messages.map((m) => m.id)).toEqual(["u-1", "a-1"]);
		expect(messages.map((m) => m.id)).not.toContain(pendingId);

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});

	it("promotes the placeholder when the turn died before the init handshake", async () => {
		const repo = await repoManager.clone(fixtureRepo, `promote-${Date.now()}`);
		// No agentSessionId — the interrupted turn never got its init message,
		// so there is no transcript to backfill from.
		const session = await sessionManager.create(repo.id);
		const pendingId = insertPendingPlaceholder(session.id, "hello there");
		await sessionManager.setStatus(session.id, "working");

		await sessionManager.resetAllToIdle();

		const messages = await sessionManager.getMessages(session.id);
		expect(messages).toHaveLength(1);
		const [msg] = messages;
		if (!msg) throw new Error("unreachable");
		// Same content, permanent id: the user's message survived the restart
		// and the stable placeholder id is free for the next turn.
		expect(msg.role).toBe("user");
		expect(msg.parts).toEqual([{ type: "text", text: "hello there" }]);
		expect(msg.id).not.toBe(pendingId);

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});

	it("keeps the placeholder content even when the transcript is unreadable", async () => {
		const repo = await repoManager.clone(fixtureRepo, `unread-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		getDb()
			.update(sessionsTable)
			.set({ agentSessionId: "22222222-2222-4222-8222-222222222222" })
			.where(eq(sessionsTable.id, session.id))
			.run();
		const pendingId = insertPendingPlaceholder(session.id, "refactor auth");
		await sessionManager.setStatus(session.id, "working");

		vi.mocked(getSessionMessages).mockRejectedValueOnce(
			new Error("ENOENT: transcript gone"),
		);

		await sessionManager.resetAllToIdle();

		const messages = await sessionManager.getMessages(session.id);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.parts).toEqual([
			{ type: "text", text: "refactor auth" },
		]);
		expect(messages[0]?.id).not.toBe(pendingId);

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});
});
