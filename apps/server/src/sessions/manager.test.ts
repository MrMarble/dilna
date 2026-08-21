import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

	// ADR-0016 §2: beginTurn claims the turn slot synchronously (no `await`
	// between the check and the claim), so a second concurrent call sees the
	// claim immediately rather than racing it — this is what makes the pre-202
	// 409 the only duplicate-send surface.
	it("rejects a second beginTurn while one is already claimed, and persists the pending user message", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`begin-turn-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);

		expect(sessionManager.isChatInProgress(session.id)).toBe(false);
		const message = sessionManager.beginTurn(session.id, "hello there");
		expect(sessionManager.isChatInProgress(session.id)).toBe(true);
		expect(message.role).toBe("user");
		expect(message.parts).toEqual([{ type: "text", text: "hello there" }]);

		expect(() => sessionManager.beginTurn(session.id, "again")).toThrow(
			"session already has a chat in progress",
		);

		// The pending placeholder is persisted immediately, not just claimed
		// in memory.
		const persisted = await sessionManager.getMessages(session.id);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.id).toBe(message.id);

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});

	it("beginTurn throws for a session that doesn't exist", () => {
		expect(() => sessionManager.beginTurn("no-such-session", "hi")).toThrow(
			"session not found",
		);
	});

	// ADR-0016 §1: a crashed session must reopen crashed for a new
	// subscriber, not silently reset to idle.
	it("subscribe() opens a crashed session as crashed, not idle", async () => {
		const repo = await repoManager.clone(fixtureRepo, `crashed-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		await sessionManager.setStatus(session.id, "crashed");

		const received: string[] = [];
		const unsubscribe = sessionManager.subscribe(session.id, (ev) => {
			if (ev.type === "session_status") received.push(ev.status);
		});
		unsubscribe();

		expect(received).toEqual(["crashed"]);

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
 * ADR-0017: the 5-minute idle-kill timer must not tear down the resident
 * Claude CLI process while the SDK reports in-flight background work (a
 * `run_in_background` shell job) or a pending `ScheduleWakeup`/`CronCreate`/
 * `/loop` registration — either would be silently orphaned (the child dies
 * with the parent per ADR-0014). Reaches into `SessionManager`'s private
 * idle-timer methods directly (via a narrow structural cast) rather than
 * driving a full mocked turn through `startClaude`/`chatClaude`: the guard
 * being tested lives entirely in `armIdleTimer`/`handlePendingWorkChanged`/
 * `idleKill`, and a fake `ActiveAgent` exercises exactly that without also
 * having to fake transcript persistence, changed-files diffing, etc.
 */
describe("idle-kill defers to pending background work (ADR-0017)", () => {
	it("skips the idle-kill while pending work is signaled, and resumes it once cleared", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`idle-pending-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);

		const stop = vi.fn().mockResolvedValue(undefined);
		const activeAgent = {
			handle: { stop, isAlive: () => true },
			idleTimer: null as NodeJS.Timeout | null,
			liveTurn: null,
			hasPendingBackgroundWork: false,
		};
		const manager = sessionManager as unknown as {
			active: Map<string, typeof activeAgent>;
			armIdleTimer: (id: string, active: typeof activeAgent) => void;
			handlePendingWorkChanged: (id: string, hasPendingWork: boolean) => void;
		};
		manager.active.set(session.id, activeAgent);

		vi.useFakeTimers();
		try {
			// Mirrors the Stop hook firing with a live wakeup/background task,
			// then the normal turn-end path trying to arm the timer as usual —
			// it must be a no-op while pending work is flagged.
			manager.handlePendingWorkChanged(session.id, true);
			manager.armIdleTimer(session.id, activeAgent);
			await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
			expect(stop).not.toHaveBeenCalled();

			// Once the pending work clears, nothing else tells SessionManager an
			// autonomous cron-fired response happened — handlePendingWorkChanged
			// itself must resume the countdown.
			manager.handlePendingWorkChanged(session.id, false);
			await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
			expect(stop).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}

		manager.active.delete(session.id);
		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
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

	it("drops a background task-notification entry, flushing the pre-task turn without persisting it as a user message", () => {
		// No `origin` field here: getSessionMessages' own entry mapper strips it
		// before dilna ever sees the entry (see claudeMessagesToDilna's doc
		// comment), so detection has to key off the `<task-notification>` text
		// itself, not `origin.kind`.
		const raw = [
			entry("user", "u-1", "kick off research"),
			entry("assistant", "a-1", "on it, running in the background"),
			{
				type: "user",
				uuid: "tn-1",
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: "<task-notification>\n<status>completed</status>\n</task-notification>",
						},
					],
				},
			},
			entry("assistant", "a-2", "here's what it found"),
		];
		const messages = claudeMessagesToDilna("s1", raw as Raw);

		// The notification never becomes its own row, but does split the two
		// assistant turns it falls between (mirroring the live turn boundary).
		expect(messages.map((m) => m.id)).toEqual(["u-1", "a-1", "a-2"]);
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"assistant",
		]);
	});
});
