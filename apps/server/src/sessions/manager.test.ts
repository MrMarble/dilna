import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db";
import { rateLimits as rateLimitsTable } from "../db/schema";
import { repoManager } from "../repos/manager";
import {
	applyEventToLiveTurn,
	claudeMessagesToDilna,
	type LiveTurn,
	liveTurnReplayEvents,
	sessionManager,
} from "./manager";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

let dataDir: string;
let fixtureRepo: string;
let oldDataDir: string | undefined;

beforeAll(async () => {
	// Redirect dilna data dir to a temp directory.
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;

	// Build a tiny fixture git repo we can clone from.
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

describe("SessionManager", () => {
	it("creates a session backed by a real git worktree", async () => {
		const repo = await repoManager.clone(fixtureRepo);
		expect(repo.defaultBranch).toBe("main");

		const session = await sessionManager.create(repo.id);
		expect(session.status).toBe("idle");
		expect(session.title).toBe(`Session ${session.id.slice(0, 4)}`);
		expect(session.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

		// Worktree on disk
		const worktreePath = path.join(dataDir, "worktrees", repo.slug, session.id);
		expect(existsSync(worktreePath)).toBe(true);
		expect(existsSync(path.join(worktreePath, "README.md"))).toBe(true);

		// git worktree list shows it under the dilna/<id> branch
		const { stdout } = await git(["worktree", "list"], { cwd: repo.path });
		expect(stdout).toContain(`dilna/${session.id}`);

		// listByRepo returns the session
		const sessions = await sessionManager.listByRepo(repo.id);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.id).toBe(session.id);

		// getView hides internal fields
		const view = await sessionManager.getView(session.id);
		expect(view).not.toBeNull();
		expect(view).not.toHaveProperty("worktreePath");
		expect(view).not.toHaveProperty("branchName");
		expect(view).not.toHaveProperty("agentSessionId");
	});

	it("hides the sandbox-injected .gitmodules from the worktree's git status", async () => {
		const repo = await repoManager.clone(fixtureRepo, `exclude-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		const worktreePath = path.join(dataDir, "worktrees", repo.slug, session.id);

		// Simulate Claude Code's sandbox hardening touching an empty
		// .gitmodules at the worktree root (see the exclude write in create()).
		writeFileSync(path.join(worktreePath, ".gitmodules"), "");

		const { stdout } = await git(["status", "--porcelain"], {
			cwd: worktreePath,
		});
		expect(stdout).not.toContain(".gitmodules");
	});

	it("gives worktree git working tracking refs and @{u} (fetch refspec on the bare repo)", async () => {
		const repo = await repoManager.clone(fixtureRepo, `upstream-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		const worktreePath = path.join(dataDir, "worktrees", repo.slug, session.id);
		const branch = `dilna/${session.id}`;

		// Symptom #1 of the missing refspec: `git fetch origin <branch>`
		// updated only FETCH_HEAD, leaving refs/remotes/origin/* stale/absent.
		await git(["fetch", "origin", "main"], { cwd: worktreePath });
		const { stdout: trackingMain } = await git(
			["rev-parse", "refs/remotes/origin/main"],
			{ cwd: worktreePath },
		);
		const { stdout: fixtureMain } = await git(["rev-parse", "main"], {
			cwd: fixtureRepo,
		});
		expect(trackingMain.trim()).toBe(fixtureMain.trim());

		// Symptom #2: after `push -u`, @{u} failed with "upstream branch not
		// stored as a remote-tracking branch" because upstream resolution maps
		// branch.<name>.merge through the (missing) fetch refspec.
		await git(["push", "-u", "origin", branch], { cwd: worktreePath });
		const { stdout: upstream } = await git(
			["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
			{ cwd: worktreePath },
		);
		expect(upstream.trim()).toBe(`origin/${branch}`);
	});

	it("deletes a session and removes its worktree + branch", async () => {
		const repo = await repoManager.clone(fixtureRepo, `clone-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		const worktreePath = path.join(dataDir, "worktrees", repo.slug, session.id);
		expect(existsSync(worktreePath)).toBe(true);

		await sessionManager.delete(session.id);

		expect(existsSync(worktreePath)).toBe(false);
		expect(await sessionManager.get(session.id)).toBeNull();

		// branch is gone too
		const { stdout } = await git(["branch", "--list"], { cwd: repo.path });
		expect(stdout).not.toContain(`dilna/${session.id}`);

		// worktree list doesn't show the path
		const { stdout: wtList } = await git(["worktree", "list"], {
			cwd: repo.path,
		});
		expect(wtList).not.toContain(worktreePath);
	});

	it("resetAllToIdle flips working sessions back to idle", async () => {
		const repo = await repoManager.clone(fixtureRepo, `reset-${Date.now()}`);
		const session = await sessionManager.create(repo.id);

		await sessionManager.setStatus(session.id, "working");
		let updated = await sessionManager.get(session.id);
		expect(updated?.status).toBe("working");

		await sessionManager.resetAllToIdle();
		updated = await sessionManager.get(session.id);
		expect(updated?.status).toBe("idle");

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});

	// Simulates the restart/reload path: a reading persisted by a previous
	// server process must be served on the very first getRateLimits() call
	// (the SSE connect snapshot), without waiting for any agent turn.
	// Depends on hydration being lazy: no earlier test in this file may call
	// getRateLimits(), or the singleton hydrates before the row exists.
	it("serves persisted rate-limit windows on first read after a restart", () => {
		const future = Math.floor(Date.now() / 1000) + 3600;
		getDb()
			.insert(rateLimitsTable)
			.values({ kind: "five_hour", utilizationPct: 32, resetsAt: future })
			.run();

		expect(sessionManager.getRateLimits()).toEqual([
			{ kind: "five_hour", utilizationPct: 32, resetsAt: future },
		]);
	});
});

/**
 * The live-turn snapshot that lets a subscriber joining mid-turn (page
 * reload, second device) catch up on the in-flight assistant message — see
 * SessionManager.subscribe and ADR-0014.
 */
describe("live turn snapshot", () => {
	const fold = (events: Parameters<typeof applyEventToLiveTurn>[1][]) =>
		events.reduce<LiveTurn | null>(applyEventToLiveTurn, null);

	it("accumulates interleaved text and tool calls in stream order", () => {
		const turn = fold([
			{ type: "message_start", messageId: "m1", role: "assistant" },
			{ type: "token", messageId: "m1", chunk: "Hel" },
			{ type: "token", messageId: "m1", chunk: "lo" },
			{
				type: "tool_call_start",
				messageId: "m1",
				callId: "c1",
				tool: "Bash",
				input: { command: "ls" },
			},
			{ type: "tool_call_end", messageId: "m1", callId: "c1", output: "ok" },
			{ type: "token", messageId: "m1", chunk: "done" },
			// Non-content events must pass the snapshot through untouched.
			{ type: "session_status", status: "working" },
		]);

		expect(turn).toEqual({
			messageId: "m1",
			parts: [
				{ type: "text", text: "Hello" },
				{
					type: "tool_call",
					callId: "c1",
					tool: "Bash",
					input: { command: "ls" },
					output: "ok",
					error: undefined,
				},
				{ type: "text", text: "done" },
			],
		});
	});

	it("opens a snapshot from a tool_call_start alone (missed message_start)", () => {
		const turn = fold([
			{
				type: "tool_call_start",
				messageId: "m1",
				callId: "c1",
				tool: "Read",
				input: {},
			},
		]);
		expect(turn?.messageId).toBe("m1");
		expect(turn?.parts).toHaveLength(1);
	});

	it("replays to the same snapshot a live-from-the-start subscriber built", () => {
		const turn = fold([
			{ type: "message_start", messageId: "m1", role: "assistant" },
			{ type: "token", messageId: "m1", chunk: "working…" },
			{
				type: "tool_call_start",
				messageId: "m1",
				callId: "c1",
				tool: "Bash",
				input: { command: "pwd" },
			},
			{ type: "tool_call_end", messageId: "m1", callId: "c1", output: "/w" },
			{
				type: "tool_call_start",
				messageId: "m1",
				callId: "c2",
				tool: "Edit",
				input: {},
			},
		]);
		if (!turn) throw new Error("unreachable");

		const replayed = fold(liveTurnReplayEvents(turn));
		expect(replayed).toEqual(turn);
	});

	it("does not emit a tool_call_end for a still-running tool call", () => {
		const turn: LiveTurn = {
			messageId: "m1",
			parts: [
				{
					type: "tool_call",
					callId: "c1",
					tool: "Bash",
					input: {},
					output: null,
				},
			],
		};
		const types = liveTurnReplayEvents(turn).map((e) => e.type);
		expect(types).toEqual(["message_start", "tool_call_start"]);
	});
});

/**
 * Regression tests for transcript timestamp synthesis. Claude transcripts
 * carry no timestamps, and the original `now + index` synthesis stamped rows
 * minutes into the future on long transcripts — so the next turn's real-time
 * pending-user placeholder sorted *before* the previous turn's rows and the
 * UI interleaved messages out of order until the next reload.
 */
describe("claudeMessagesToDilna", () => {
	type Raw = Parameters<typeof claudeMessagesToDilna>[1];

	const entry = (type: "user" | "assistant", uuid: string, text: string) => ({
		type,
		uuid,
		message: { role: type, content: [{ type: "text", text }] },
	});

	it("never stamps createdAt in the future, even on long transcripts", () => {
		const raw: unknown[] = [];
		for (let i = 0; i < 150; i++) {
			raw.push(entry("user", `u-${i}`, `question ${i}`));
			raw.push(entry("assistant", `a-${i}`, `answer ${i}`));
		}
		const messages = claudeMessagesToDilna("s1", raw as Raw);
		const now = Math.floor(Date.now() / 1000);

		expect(messages.length).toBe(300);
		for (const m of messages) {
			expect(m.createdAt).toBeLessThanOrEqual(now);
		}
	});

	it("keeps createdAt monotonically increasing in transcript order", () => {
		const raw = [
			entry("user", "u-1", "first"),
			entry("assistant", "a-1", "first answer"),
			entry("user", "u-2", "second"),
			entry("assistant", "a-2", "second answer"),
		];
		const messages = claudeMessagesToDilna("s1", raw as Raw);

		expect(messages.map((m) => m.id)).toEqual(["u-1", "a-1", "u-2", "a-2"]);
		for (let i = 1; i < messages.length; i++) {
			const prev = messages[i - 1];
			const cur = messages[i];
			if (!prev || !cur) throw new Error("unreachable");
			expect(cur.createdAt).toBeGreaterThanOrEqual(prev.createdAt);
		}
	});
});
