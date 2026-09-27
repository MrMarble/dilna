import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Message, SessionView } from "@dilna/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	dilnaMessagesToInitialState,
	type PiHandle,
	startPi,
} from "../agents/pi";
import { createServerContext } from "../container";
import * as messageStore from "./messageStore";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

/**
 * Stub out the pi agent backend entirely (same shape as
 * manager.title-fallback / manager.stop-during-spawn): these tests exercise
 * `getContextUsageEstimate`'s two paths (issue #269), not the agent. The
 * stub handle is what `startPi` resolves, so a test can plant its own
 * `agent.state.messages` — the array the live path measures — while
 * `dilnaMessagesToInitialState` (the per-row expansion that dominates the
 * cold rebuild) is observable as the very mock instance both paths call.
 *
 * `resolveSummarizationModel` resolves a catalog model so both paths
 * produce an estimate; the stub handle's provider/model pair is what the
 * live path measures against, and `resolveProviderModel` falls back to it
 * for the cold path too (the session row carries no provider/model).
 */
vi.mock("../agents/pi", () => {
	const handle = {
		kind: "pi",
		worktreePath: "",
		provider: "anthropic",
		model: "claude-opus-5",
		agent: {
			state: { messages: [] as unknown[] },
			// runTurn subscribes for the turn's duration; the stub emits nothing.
			subscribe: vi.fn().mockReturnValue(() => {}),
		},
		listeners: new Set(),
		stop: vi.fn().mockResolvedValue(undefined),
		isAlive: vi.fn().mockReturnValue(true),
		stderrTail: [],
		resetTurnLimits: vi.fn(),
	};
	return {
		startPi: vi.fn().mockResolvedValue(handle),
		startOrchestrator: vi.fn().mockResolvedValue(handle),
		chatPi: vi.fn().mockResolvedValue(undefined),
		generateSessionTitle: vi.fn().mockResolvedValue(null),
		dilnaMessagesToInitialState: vi.fn().mockReturnValue([]),
		piMessagesToDilna: vi.fn().mockReturnValue([]),
		piRoundToDilnaMessage: vi.fn().mockReturnValue([]),
		resolveSummarizationModel: vi.fn().mockReturnValue({
			id: "claude-opus-5",
			contextWindow: 1_000_000,
		}),
		summarizeMessages: vi.fn().mockResolvedValue(null),
		judgeComplete: vi.fn().mockResolvedValue(null),
	};
});

let dataDir: string;
let fixtureRepo: string;
let oldDataDir: string | undefined;

let repoManager: ReturnType<typeof createServerContext>["repos"];
let sessionManager: ReturnType<typeof createServerContext>["sessions"];

beforeAll(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-context-usage-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;

	fixtureRepo = mkdtempSync(path.join(tmpdir(), "dilna-fixture-"));
	await git(["init", "-b", "main", fixtureRepo]);
	await git(["config", "user.email", "test@dilna.local"], { cwd: fixtureRepo });
	await git(["config", "user.name", "dilna test"], { cwd: fixtureRepo });
	writeFileSync(path.join(fixtureRepo, "README.md"), "# fixture\n");
	await git(["add", "."], { cwd: fixtureRepo });
	await git(["commit", "-m", "initial"], { cwd: fixtureRepo });

	({ repos: repoManager, sessions: sessionManager } = createServerContext());
});

afterAll(async () => {
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fixtureRepo, { recursive: true, force: true });
});

/** A completed assistant round with a real provider report — the shape a
 * live agent's transcript holds after every finished round. */
function liveRound(
	usage: { input: number; output: number; cacheRead: number },
	timestamp: number,
): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5",
		usage: {
			...usage,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/** A Session with a long, tool-heavy persisted history — exactly the shape
 * where rebuilding the transcript from `messages` rows dominates a page
 * load (issue #269's motivating cost) — plus one completed turn, so a live
 * `Agent` exists in the manager's active map. */
async function createSessionWithHistory(
	rowCount: number,
): Promise<SessionView> {
	const repo = await repoManager.clone(
		fixtureRepo,
		`ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	const session = await sessionManager.create(repo.id);
	for (let i = 0; i < rowCount; i++) {
		const row: Message = {
			id: `hist-${session.id}-${i}`,
			sessionId: session.id,
			role: i % 2 === 0 ? "user" : "assistant",
			parts: [
				{ type: "text", text: `message ${i} — ${"lorem ipsum ".repeat(20)}` },
			],
			turnId: null,
			createdAt: 1_700_000_000 + i,
		};
		messageStore.persistMessage(session.id, row);
	}
	// One mocked turn (chatPi resolves, emits nothing) so the manager holds
	// an active agent for this Session — the live path's precondition.
	sessionManager.beginTurn(session.id, "go");
	await sessionManager.runTurn(session.id, "go");
	return session;
}

describe("getContextUsageEstimate (issue #269)", () => {
	it("measures the live Agent's own array without rebuilding the transcript", async () => {
		const session = await createSessionWithHistory(60);
		const handle = (await startPi({} as never)) as PiHandle;
		handle.agent.state.messages = [
			{ role: "user", content: "hi", timestamp: 1 },
			liveRound({ input: 900, output: 100, cacheRead: 5_000 }, 2),
		] as never[];

		const rebuild = vi.mocked(dilnaMessagesToInitialState);
		rebuild.mockClear();

		const estimate = await sessionManager.getContextUsageEstimate(session.id);

		// Grounded in the planted report — not derived from the 60 persisted
		// rows, and labelled provider-reported, not estimated.
		expect(estimate).toMatchObject({
			tokens: 6_000,
			usageTokens: 6_000,
			trailingTokens: 0,
			contextWindow: 1_000_000,
			source: "provider",
		});
		// The measurable saving (issue #269's last criterion): zero row
		// expansions where the pre-change path expanded all 60 persisted
		// rows on every page load — the expansion count is the proxy that
		// scales with history length.
		expect(rebuild).not.toHaveBeenCalled();

		await sessionManager.delete(session.id);
	});

	it("excludes the in-flight turn's user message on the live path", async () => {
		const session = await createSessionWithHistory(4);
		const handle = (await startPi({} as never)) as PiHandle;
		handle.agent.state.messages = [
			{ role: "user", content: "hi", timestamp: 1 },
			liveRound({ input: 900, output: 100, cacheRead: 0 }, 2),
			// The turn currently running: prompted, no round completed yet.
			{ role: "user", content: "x".repeat(80_000), timestamp: 3 },
		] as never[];

		const estimate = await sessionManager.getContextUsageEstimate(session.id);
		// The huge in-flight prompt is not yet prior context — the meter
		// reflects the last completed turn, not the running one.
		expect(estimate?.tokens).toBe(1_000);
		expect(estimate?.trailingTokens).toBe(0);

		await sessionManager.delete(session.id);
	});

	it("still rebuilds from rows (labelled an estimate) once no live Agent exists", async () => {
		const session = await createSessionWithHistory(6);
		const handle = (await startPi({} as never)) as PiHandle;
		handle.agent.state.messages = [];

		const rebuild = vi.mocked(dilnaMessagesToInitialState);
		rebuild.mockClear();
		await sessionManager.stopSession(session.id);

		const estimate = await sessionManager.getContextUsageEstimate(session.id);
		// The rebuild ran — dilnaMessagesToInitialState over the persisted
		// history — and the figure is honestly labelled an estimate (the
		// mock's rows carry no usable usage blocks, matching real converted
		// rows, which stamp a zeroed usage).
		expect(rebuild).toHaveBeenCalled();
		expect(estimate?.source).toBe("estimated");
		// The pending user row (persisted by beginTurn) is not prior
		// context: no expansion call may include it.
		for (const call of rebuild.mock.calls) {
			for (const row of call[0] as Message[]) {
				expect(row.id).not.toBe(`pending-user-${session.id}`);
			}
		}

		await sessionManager.delete(session.id);
	});
});
