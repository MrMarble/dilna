import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServerContext } from "../container";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

// Stub out the pi agent backend (manager.stop-during-spawn.test.ts's
// precedent): what's under test here is the comparison lifecycle — arm
// creation, model pinning, group id, prompt fan-out — not the agent loop,
// so chatPi just resolves and every turn ends immediately.
vi.mock("../agents/pi", () => {
	const handle = {
		kind: "pi",
		worktreePath: "",
		agent: { state: { messages: [] } },
		listeners: new Set(),
		stop: vi.fn().mockResolvedValue(undefined),
		isAlive: vi.fn().mockReturnValue(true),
		stderrTail: [],
	};
	return {
		startPi: vi.fn().mockResolvedValue(handle),
		startOrchestrator: vi.fn().mockResolvedValue(handle),
		chatPi: vi.fn().mockResolvedValue(undefined),
		generateSessionTitle: vi.fn().mockResolvedValue(null),
		dilnaMessagesToInitialState: vi.fn().mockReturnValue([]),
		piMessagesToDilna: vi.fn().mockReturnValue([]),
		piRoundToDilnaMessage: vi.fn().mockReturnValue(null),
	};
});

let dataDir: string;
let fixtureRepo: string;
let oldDataDir: string | undefined;
let oldKeys: Record<string, string | undefined>;

// Real catalog ids — validateModelChoice checks the arm's model against the
// same generated catalog the agent startup path resolves from, so a made-up
// id would only prove the rejection path.
const anthropicModel = getBuiltinModels("anthropic")[0]?.id ?? "";
const deepseekModel = getBuiltinModels("deepseek")[0]?.id ?? "";

let repoManager: ReturnType<typeof createServerContext>["repos"];
let sessionManager: ReturnType<typeof createServerContext>["sessions"];

beforeAll(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-compare-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
	// validateModelChoice requires a resolvable API key per arm's provider —
	// getEnvApiKey reads process.env live, so fake keys satisfy it here.
	oldKeys = {
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
	};
	process.env.ANTHROPIC_API_KEY = "test-key";
	process.env.DEEPSEEK_API_KEY = "test-key";

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
	process.env.ANTHROPIC_API_KEY = oldKeys.ANTHROPIC_API_KEY;
	process.env.DEEPSEEK_API_KEY = oldKeys.DEEPSEEK_API_KEY;
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fixtureRepo, { recursive: true, force: true });
});

/** The prompt fan-out is fire-and-forget (runTurn per arm, unawaited), so
 * the persisted user row can land a tick after createComparison resolves —
 * poll briefly rather than race it. */
async function waitForUserMessage(sessionId: string, prompt: string) {
	for (let i = 0; i < 40; i++) {
		const messages = await sessionManager.getMessages(sessionId);
		if (
			messages.some(
				(m) =>
					m.role === "user" &&
					m.parts.some((p) => p.type === "text" && p.text === prompt),
			)
		) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`user message never persisted on ${sessionId}`);
}

describe("SessionManager.createComparison (issue #250, ADR-0047)", () => {
	it("creates each arm pinned to its caller-chosen model, grouped, and fans the prompt out", async () => {
		expect(anthropicModel).toBeTruthy();
		expect(deepseekModel).toBeTruthy();
		const repo = await repoManager.clone(fixtureRepo, `cmp-${Date.now()}`);
		const prompt = "Explain the build system.";
		const { groupId, sessions } = await sessionManager.createComparison(
			repo.id,
			prompt,
			[
				{ provider: "anthropic", model: anthropicModel },
				{ provider: "deepseek", model: deepseekModel },
			],
		);

		expect(sessions).toHaveLength(2);
		expect(sessions.map((s) => s.provider)).toEqual(["anthropic", "deepseek"]);
		expect(sessions.map((s) => s.model)).toEqual([
			anthropicModel,
			deepseekModel,
		]);

		// Arms are ordinary Sessions: distinct worktrees on distinct branches,
		// sharing one group id that SessionView deliberately omits.
		const fulls = await Promise.all(
			sessions.map((s) => sessionManager.get(s.id)),
		);
		for (const full of fulls) {
			expect(full?.comparisonGroupId).toBe(groupId);
		}
		expect(fulls[0]?.worktreePath).not.toBe(fulls[1]?.worktreePath);
		expect(sessions[0]).not.toHaveProperty("comparisonGroupId");

		// The group reads back in creation order — the column order.
		const arms = await sessionManager.getComparison(groupId);
		expect(arms?.map((a) => a.id)).toEqual(sessions.map((s) => s.id));

		// One prompt, both arms: the user row is persisted per arm.
		await Promise.all(sessions.map((s) => waitForUserMessage(s.id, prompt)));

		const [arm0, arm1] = sessions;
		if (!arm0 || !arm1) throw new Error("expected two arms");
		await sessionManager.delete(arm0.id);
		await sessionManager.delete(arm1.id);
		await repoManager.delete(repo.id);
	});

	it("rolls back the arms that landed when a later arm fails, leaving no group", async () => {
		const repo = await repoManager.clone(fixtureRepo, `cmp-rb-${Date.now()}`);
		await expect(
			sessionManager.createComparison(repo.id, "Explain the build system.", [
				{ provider: "anthropic", model: anthropicModel },
				// Invalid on purpose: not in the catalog. create() throws before
				// arm 2's worktree exists; arm 1 must not survive half a group.
				{ provider: "anthropic", model: "definitely-not-a-model" },
			]),
		).rejects.toThrow(/not a known model/);

		const sessions = await sessionManager.listByRepo(repo.id);
		expect(sessions).toHaveLength(0);
		await repoManager.delete(repo.id);
	});

	it("reads null for a group id with no surviving arms", async () => {
		expect(await sessionManager.getComparison("no-such-group")).toBeNull();
	});
});

describe("SessionManager.create with caller-pinned model (issue #250)", () => {
	it("rejects half a pair", async () => {
		const repo = await repoManager.clone(fixtureRepo, `cmp-half-${Date.now()}`);
		await expect(
			sessionManager.create(repo.id, "pi", "session", null, {
				provider: "anthropic",
			}),
		).rejects.toThrow(/together/);
		await repoManager.delete(repo.id);
	});
});
