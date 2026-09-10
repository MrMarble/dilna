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

	it("leaves spawnedBy null for a Session created directly (not by an orchestrator)", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`spawned-null-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);
		const full = await sessionManager.get(session.id);
		expect(full?.spawnedBy).toBeNull();
	});

	it("records spawnedBy when a Session is created on an orchestrator's behalf (ADR-0025)", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`spawned-by-${Date.now()}`,
		);
		const child = await sessionManager.create(
			repo.id,
			"pi",
			"session",
			"orchestrator-session-1",
		);
		const full = await sessionManager.get(child.id);
		expect(full?.spawnedBy).toBe("orchestrator-session-1");
		// Not part of the client-facing view — internal to the orchestrator's
		// own lineage bookkeeping (ADR-0025).
		expect(child).not.toHaveProperty("spawnedBy");
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

	it("creates an orchestrator session bound to the hidden meta-repo", async () => {
		const session = await sessionManager.createOrchestrator();
		expect(session.kind).toBe("orchestrator");
		expect(session.title).toBe("Orchestrator");

		const metaRepo = await repoManager.ensureOrchestratorRepo();
		expect(session.repoId).toBe(metaRepo.id);

		// A real worktree, same as any other Session — it just has no
		// filesystem tools registered against it (see agents/pi.ts).
		const full = await sessionManager.get(session.id);
		expect(full).not.toBeNull();
		expect(existsSync(full?.worktreePath ?? "")).toBe(true);

		// The meta-repo itself never shows up in the normal repo list.
		const repos = await repoManager.list();
		expect(repos.find((r) => r.id === metaRepo.id)).toBeUndefined();
	});

	it('ordinary create() defaults to kind "session"', async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`kind-default-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);
		expect(session.kind).toBe("session");
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

	// ADR-0026: resetAllToIdle must leave a durable, visible trace that a
	// turn was interrupted — a client reconnecting long after the restart
	// (nobody necessarily watching when the process died) should see why
	// the turn stops abruptly instead of silent nothing.
	it("resetAllToIdle persists a system-role interruption notice", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`reset-notice-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);

		sessionManager.beginTurn(session.id, "do the thing");
		await sessionManager.setStatus(session.id, "working");

		await sessionManager.resetAllToIdle();

		const persisted = await sessionManager.getMessages(session.id);
		const notice = persisted.find((m) => m.role === "system");
		expect(notice).toBeDefined();
		expect(notice?.parts).toEqual([
			{ type: "text", text: expect.stringContaining("interrupted") },
		]);
		// The user's own message survives too (promoted, not the notice).
		expect(persisted.some((m) => m.role === "user")).toBe(true);

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
 * Idle-kill timer arms unconditionally on turn end. `pi.ts` has no
 * background-work/scheduled-wakeup signal (see `armIdleTimer`'s doc comment
 * on `SessionManager`) — ADR-0017's original Claude-Stop-hook-deferred
 * variant of this test was removed alongside that mechanism, not ported.
 */
describe("idle-kill", () => {
	it("stops the agent after the timer elapses with no turn in progress", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`idle-kill-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);

		const stop = vi.fn().mockResolvedValue(undefined);
		const activeAgent = {
			handle: { stop, isAlive: () => true },
			idleTimer: null as NodeJS.Timeout | null,
			liveTurn: null,
		};
		const manager = sessionManager as unknown as {
			active: Map<string, typeof activeAgent>;
			armIdleTimer: (id: string, active: typeof activeAgent) => void;
		};
		manager.active.set(session.id, activeAgent);

		vi.useFakeTimers();
		try {
			manager.armIdleTimer(session.id, activeAgent);
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

/** ADR-0026: graceful shutdown. `drain()` is only ever called once per real
 * process (on the way to `process.exit`), so these tests reset `draining`
 * back to `false` afterward — a leaked `true` would break every later
 * `beginTurn` call in this file.
 *
 * Both bits of state now live on the manager's `TurnRegistry` collaborator
 * (issue #149), so the private-access cast reaches one level deeper; the
 * behaviour under test is unchanged and still driven through the manager's
 * own public `drain()`/`beginTurn()`. */
describe("graceful shutdown", () => {
	function registry() {
		return (
			sessionManager as unknown as {
				turns: {
					draining: boolean;
					runningTurns: Map<string, Promise<void>>;
				};
			}
		).turns;
	}

	it("beginTurn rejects new turns once drain() has started", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`drain-reject-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);

		try {
			await sessionManager.drain(0);
			expect(() => sessionManager.beginTurn(session.id, "hi")).toThrow(
				"server is shutting down",
			);
		} finally {
			registry().draining = false;
		}

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});

	it("drain() resolves once a tracked in-flight turn finishes, before the timeout", async () => {
		let resolveTurn: () => void = () => {};
		const turnPromise = new Promise<void>((resolve) => {
			resolveTurn = resolve;
		});
		sessionManager.trackRunningTurn("fake-drain-session", turnPromise);

		vi.useFakeTimers();
		try {
			const drainPromise = sessionManager.drain(5000);
			await vi.advanceTimersByTimeAsync(1000);
			resolveTurn();
			await drainPromise;
		} finally {
			vi.useRealTimers();
			registry().draining = false;
			registry().runningTurns.delete("fake-drain-session");
		}
	});

	it("drain() gives up after the timeout if a turn never finishes", async () => {
		const neverResolves = new Promise<void>(() => {});
		sessionManager.trackRunningTurn("stuck-drain-session", neverResolves);

		vi.useFakeTimers();
		try {
			const drainPromise = sessionManager.drain(5000);
			await vi.advanceTimersByTimeAsync(5000);
			await drainPromise;
		} finally {
			vi.useRealTimers();
			registry().draining = false;
			registry().runningTurns.delete("stuck-drain-session");
		}
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
 * ADR-0026: incremental persistence. `persistRoundEvent` is exercised
 * directly (via the same private-access-cast pattern as `idle-kill` above)
 * with hand-built raw pi-agent-core event shapes — synthesizing a real
 * `pi-agent-core` `Agent`/turn just to reach `turn_end` would be a much
 * heavier test for the same coverage.
 */
describe("incremental persistence (ADR-0026)", () => {
	function userMessageEnd(text: string, timestamp: number) {
		return {
			type: "message_end",
			message: { role: "user", content: text, timestamp },
		};
	}

	function turnEnd(
		assistantContent: unknown[],
		toolResults: { toolCallId: string; text: string; timestamp: number }[],
		timestamp: number,
	) {
		return {
			type: "turn_end",
			message: { role: "assistant", content: assistantContent, timestamp },
			toolResults: toolResults.map((r) => ({
				role: "toolResult",
				toolCallId: r.toolCallId,
				toolName: "bash",
				content: [{ type: "text", text: r.text }],
				isError: false,
				timestamp: r.timestamp,
			})),
		};
	}

	function withPersistRoundEvent() {
		return sessionManager as unknown as {
			persistRoundEvent: (
				id: string,
				active: { persistedCount: number },
				event: unknown,
				turnId: string,
			) => void;
		};
	}

	it("advances persistedCount and persists a row per completed round", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`round-event-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);
		const manager = withPersistRoundEvent();
		const active = { persistedCount: 0 };

		manager.persistRoundEvent(
			session.id,
			active,
			userMessageEnd("hi", 1_000),
			"turn-1",
		);
		expect(active.persistedCount).toBe(1);

		manager.persistRoundEvent(
			session.id,
			active,
			turnEnd(
				[
					{ type: "text", text: "Running tests…" },
					{
						type: "toolCall",
						id: "c1",
						name: "bash",
						arguments: { command: "npm test" },
					},
				],
				[{ toolCallId: "c1", text: "3 passed", timestamp: 1_200 }],
				1_100,
			),
			"turn-1",
		);
		// 1 assistant message + 1 tool result = advance by 2, on top of the
		// user message's +1 above.
		expect(active.persistedCount).toBe(3);

		const persisted = await sessionManager.getMessages(session.id);
		const round = persisted.find((m) => m.role === "assistant");
		expect(round?.parts).toEqual([
			{ type: "text", text: "Running tests…" },
			{
				type: "tool_call",
				callId: "c1",
				tool: "bash",
				input: { command: "npm test" },
				output: "3 passed",
				error: undefined,
			},
		]);
		// The row carries the turn's id (ADR-0026 §3 follow-up), which is what
		// lets the web client regroup a multi-round turn into one message.
		expect(round?.turnId).toBe("turn-1");

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});

	// The regression this follow-up exists for: a turn that calls tools across
	// several rounds persists as several rows, and those rows must share one
	// turnId so the chat can regroup them into the single message the live view
	// shows (instead of N messages per round after a reload).
	it("stamps every round of one turn with the same turnId", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`round-turnid-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);
		const manager = withPersistRoundEvent();
		const active = { persistedCount: 0 };
		const turnId = "the-turn";

		manager.persistRoundEvent(
			session.id,
			active,
			userMessageEnd("do a big refactor", 1_000),
			turnId,
		);
		for (const [i, text] of ["first", "second", "third"].entries()) {
			manager.persistRoundEvent(
				session.id,
				active,
				turnEnd(
					[{ type: "text", text }],
					[{ toolCallId: `c${i}`, text: "ok", timestamp: 1_100 + i }],
					1_100 + i,
				),
				turnId,
			);
		}

		const persisted = await sessionManager.getMessages(session.id);
		const assistantRows = persisted.filter((m) => m.role === "assistant");

		// Three rounds, three rows — the per-round durability ADR-0026 bought.
		expect(assistantRows).toHaveLength(3);
		// All three claim the same turn, and each keeps its own primary key.
		expect(assistantRows.map((m) => m.turnId)).toEqual([
			turnId,
			turnId,
			turnId,
		]);
		expect(new Set(assistantRows.map((m) => m.id)).size).toBe(3);
		// The user's own row is deliberately not part of the group. (`null` and
		// `undefined` are equivalent here — both mean "never grouped", per
		// `foldTurnRows` — so assert the contract rather than the encoding:
		// the placeholder writes `null`, a safety-net row omits the key.)
		expect(persisted.find((m) => m.role === "user")?.turnId ?? null).toBeNull();

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});

	// The actual end-to-end scenario this plan exists to fix: a turn dies
	// mid-flight (process kill) after some rounds already landed
	// incrementally — the completed round, the user's own message, and a
	// visible interruption notice must all survive resetAllToIdle's boot-time
	// recovery, even though the turn never reached its own end-of-turn
	// persist (which only runs from inside runTurn's own finally block).
	it("survives a simulated mid-turn kill: completed round + user message + interruption notice all persist", async () => {
		const repo = await repoManager.clone(
			fixtureRepo,
			`round-kill-${Date.now()}`,
		);
		const session = await sessionManager.create(repo.id);
		const manager = withPersistRoundEvent();
		const active = { persistedCount: 0 };

		sessionManager.beginTurn(session.id, "do a big refactor");
		await sessionManager.setStatus(session.id, "working");

		manager.persistRoundEvent(
			session.id,
			active,
			userMessageEnd("do a big refactor", 1_000),
			"turn-kill",
		);
		manager.persistRoundEvent(
			session.id,
			active,
			turnEnd(
				[{ type: "text", text: "Starting with the first file." }],
				[],
				1_100,
			),
			"turn-kill",
		);
		// The process dies here — runTurn's own end-of-turn persist never runs.

		await sessionManager.resetAllToIdle();

		const persisted = await sessionManager.getMessages(session.id);
		expect(persisted.find((m) => m.role === "user")?.parts).toEqual([
			{ type: "text", text: "do a big refactor" },
		]);
		expect(persisted.find((m) => m.role === "assistant")?.parts).toEqual([
			{ type: "text", text: "Starting with the first file." },
		]);
		expect(persisted.find((m) => m.role === "system")?.parts).toEqual([
			{ type: "text", text: expect.stringContaining("interrupted") },
		]);

		const updated = await sessionManager.get(session.id);
		expect(updated?.status).toBe("idle");

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});
});
