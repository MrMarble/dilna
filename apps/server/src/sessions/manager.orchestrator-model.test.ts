/**
 * biome-ignore-all lint/suspicious/noExplicitAny: reaches the private
 * `buildOrchestratorDeps` seam — the deps object the orchestrator's tools
 * are actually constructed with — instead of re-implementing it.
 */
import { execFile } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clearModelRole, setModelRole } from "../agents/modelRoles";
import { createOrchestratorTools } from "../agents/orchestratorTools";
import { createServerContext } from "../container";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

// Same agent stub as manager.comparison.test.ts: under test is the spawn
// path's model pinning, not the agent loop.
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
		// Delete's archival summary: no model → archived without one.
		resolveSummarizationModel: vi.fn().mockReturnValue(undefined),
	};
});

let dataDir: string;
let fixtureRepo: string;
let oldEnv: Record<string, string | undefined>;

const defaultModel = getBuiltinModels("anthropic")[0]?.id ?? "";
const cheapA = getBuiltinModels("deepseek")[0]?.id ?? "";
const cheapB = getBuiltinModels("deepseek")[1]?.id ?? "";

let repos: ReturnType<typeof createServerContext>["repos"];
let sessions: ReturnType<typeof createServerContext>["sessions"];

beforeAll(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-orch-model-"));
	oldEnv = {
		DILNA_DATA_DIR: process.env.DILNA_DATA_DIR,
		DILNA_PROVIDER: process.env.DILNA_PROVIDER,
		DILNA_MODEL: process.env.DILNA_MODEL,
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
	};
	process.env.DILNA_DATA_DIR = dataDir;
	process.env.DILNA_PROVIDER = "anthropic";
	process.env.DILNA_MODEL = defaultModel;
	process.env.ANTHROPIC_API_KEY = "test-key";
	process.env.DEEPSEEK_API_KEY = "test-key";

	fixtureRepo = mkdtempSync(path.join(tmpdir(), "dilna-fixture-"));
	await git(["init", "-b", "main", fixtureRepo]);
	await git(["config", "user.email", "test@dilna.local"], { cwd: fixtureRepo });
	await git(["config", "user.name", "dilna test"], { cwd: fixtureRepo });
	writeFileSync(path.join(fixtureRepo, "README.md"), "# fixture\n");
	await git(["add", "."], { cwd: fixtureRepo });
	await git(["commit", "-m", "initial"], { cwd: fixtureRepo });

	({ repos, sessions } = createServerContext());
});

afterAll(() => {
	for (const [k, v] of Object.entries(oldEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fixtureRepo, { recursive: true, force: true });
});

function spawnTool() {
	const deps = (sessions as any).buildOrchestratorDeps("orch-1");
	const tool = createOrchestratorTools(deps).find(
		(t) => t.name === "dilna_create_session",
	);
	if (!tool) throw new Error("dilna_create_session missing");
	return tool;
}

function resultJson(result: any) {
	return JSON.parse(result.content[0].text);
}

describe("dilna_create_session model pinning (issue #309)", () => {
	it("pins a spawned Session to the cheap role, re-resolving the role on every spawn", async () => {
		expect(cheapA && cheapB && cheapA !== cheapB).toBeTruthy();
		const repo = await repos.clone(fixtureRepo, `orch-role-${Date.now()}`);
		await setModelRole("cheap", "deepseek", cheapA);
		const tool = spawnTool();

		const first = resultJson(
			await tool.execute("c1", {
				repoId: repo.id,
				prompt: "Bump the lockfile.",
				model: "cheap",
			}),
		);
		// The result names the role, never the concrete model behind it.
		expect(first.model).toBe("cheap");
		expect(JSON.stringify(first)).not.toContain(cheapA);
		const firstView = await sessions.getView(first.id);
		expect(firstView).toMatchObject({ provider: "deepseek", model: cheapA });

		// Re-pointed in Settings → the very next spawn follows it.
		await setModelRole("cheap", "deepseek", cheapB);
		const second = resultJson(
			await tool.execute("c2", {
				repoId: repo.id,
				prompt: "Rename the helper.",
				model: "cheap",
			}),
		);
		expect(await sessions.getView(second.id)).toMatchObject({
			provider: "deepseek",
			model: cheapB,
		});

		// Omitted → the instance default, exactly as before.
		const third = resultJson(
			await tool.execute("c3", { repoId: repo.id, prompt: "Design it." }),
		);
		expect(third.model).toBeUndefined();
		expect(await sessions.getView(third.id)).toMatchObject({
			provider: "anthropic",
			model: defaultModel,
		});

		for (const r of [first, second, third]) await sessions.delete(r.id);
		await repos.delete(repo.id);
		clearModelRole("cheap");
	});

	it("accepts a concrete provider/model pair, validated like a user pin", async () => {
		const repo = await repos.clone(fixtureRepo, `orch-pair-${Date.now()}`);
		const result = resultJson(
			await spawnTool().execute("c1", {
				repoId: repo.id,
				prompt: "p",
				model: `deepseek/${cheapA}`,
			}),
		);
		expect(await sessions.getView(result.id)).toMatchObject({
			provider: "deepseek",
			model: cheapA,
		});
		await sessions.delete(result.id);
		await repos.delete(repo.id);
	});

	it("falls back to the instance default, with a note, when the role is unset", async () => {
		clearModelRole("cheap");
		const repo = await repos.clone(fixtureRepo, `orch-unset-${Date.now()}`);
		const result = resultJson(
			await spawnTool().execute("c1", {
				repoId: repo.id,
				prompt: "p",
				model: "cheap",
			}),
		);
		expect(result.note).toMatch(/isn't configured/);
		expect(await sessions.getView(result.id)).toMatchObject({
			provider: "anthropic",
			model: defaultModel,
		});
		await sessions.delete(result.id);
		await repos.delete(repo.id);
	});

	it.each([
		["an unknown role", "expensive", /not a model role/],
		["a pair outside the catalog", "deepseek/not-a-model", /not a known model/],
		["an unknown provider", "nope/x", /not a supported provider/],
	])("rejects %s with an actionable error and leaves nothing behind", async (_label, model, error) => {
		const repo = await repos.clone(fixtureRepo, `orch-bad-${Date.now()}`);
		await expect(
			spawnTool().execute("c1", { repoId: repo.id, prompt: "p", model }),
		).rejects.toThrow(error);

		expect(await sessions.listByRepo(repo.id)).toHaveLength(0);
		const worktrees = repos.worktreeBase(repo.slug);
		expect(existsSync(worktrees) ? readdirSync(worktrees) : []).toEqual([]);
		await repos.delete(repo.id);
	});

	it("does not spend the per-turn cap on a rejected choice", async () => {
		const repo = await repos.clone(fixtureRepo, `orch-cap-${Date.now()}`);
		const tool = spawnTool();
		for (let i = 0; i < 3; i++) {
			await expect(
				tool.execute(`bad-${i}`, {
					repoId: repo.id,
					prompt: "p",
					model: "nope",
				}),
			).rejects.toThrow();
		}
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			ids.push(
				resultJson(
					await tool.execute(`ok-${i}`, { repoId: repo.id, prompt: "p" }),
				).id,
			);
		}
		await expect(
			tool.execute("over", { repoId: repo.id, prompt: "p" }),
		).rejects.toThrow(/cap reached/);
		for (const id of ids) await sessions.delete(id);
		await repos.delete(repo.id);
	});
});
