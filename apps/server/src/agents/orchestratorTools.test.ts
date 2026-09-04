import type { SessionView } from "@dilna/shared";
import { describe, expect, it, vi } from "vitest";
import {
	createOrchestratorTools,
	ORCHESTRATOR_MAX_SESSIONS_PER_TURN,
	type OrchestratorDeps,
} from "./orchestratorTools";

vi.mock("../repos/manager", () => ({
	repoManager: {
		list: vi.fn(async () => [
			{
				id: "repo-1",
				slug: "dilna",
				path: "/data/repos/dilna",
				defaultBranch: "main",
				remoteUrl: "git@github.com:owner/dilna.git",
				createdAt: 1,
			},
		]),
	},
}));

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
	return {
		id: "sess-1",
		repoId: "repo-1",
		title: "Session sess",
		agentType: "pi",
		kind: "session",
		status: "idle",
		usage: { inputTokens: 0, outputTokens: 0 },
		createdAt: 1,
		lastActiveAt: 1,
		...overrides,
	};
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
	return {
		listSessions: vi.fn(async () => [makeSession()]),
		getSession: vi.fn(async () => ({
			...makeSession(),
			lastMessagePreview: "hello",
		})),
		createChildSession: vi.fn(async (repoId: string) =>
			makeSession({ id: "sess-new", repoId }),
		),
		usageTotalsByRepo: vi.fn(async () => [
			{ repoId: "repo-1", inputTokens: 10, outputTokens: 20 },
		]),
		listArchivedSessions: vi.fn(async () => [
			{
				sessionId: "sess-old",
				repoId: "repo-1",
				title: "Old session",
				createdAt: 1,
				archivedAt: 2,
			},
		]),
		getArchivedSession: vi.fn(async () => ({
			sessionId: "sess-old",
			repoId: "repo-1",
			title: "Old session",
			summary: "did some things",
			createdAt: 1,
			archivedAt: 2,
		})),
		...overrides,
	};
}

function toolByName(
	tools: ReturnType<typeof createOrchestratorTools>,
	name: string,
) {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`tool ${name} not found`);
	return tool;
}

function textOf(result: { content: { type: string; text?: string }[] }) {
	const part = result.content[0];
	if (part?.type !== "text" || part.text === undefined) {
		throw new Error("expected a text content part");
	}
	return part.text;
}

describe("createOrchestratorTools", () => {
	it("dilna_list_repos returns repoManager.list()'s repos, meta-repo already excluded", async () => {
		const tools = createOrchestratorTools(makeDeps());
		const result = await toolByName(tools, "dilna_list_repos").execute(
			"call-1",
			{},
		);
		expect(JSON.parse(textOf(result))).toEqual([
			{ id: "repo-1", slug: "dilna", defaultBranch: "main" },
		]);
	});

	it("dilna_list_sessions forwards repoId to deps.listSessions", async () => {
		const deps = makeDeps();
		const tools = createOrchestratorTools(deps);
		await toolByName(tools, "dilna_list_sessions").execute("call-1", {
			repoId: "repo-1",
		});
		expect(deps.listSessions).toHaveBeenCalledWith("repo-1");
	});

	it("dilna_get_session returns deps.getSession's result", async () => {
		const deps = makeDeps();
		const tools = createOrchestratorTools(deps);
		const result = await toolByName(tools, "dilna_get_session").execute(
			"call-1",
			{
				sessionId: "sess-1",
			},
		);
		expect(JSON.parse(textOf(result))).toMatchObject({
			id: "sess-1",
			lastMessagePreview: "hello",
		});
	});

	it("dilna_usage_totals returns deps.usageTotalsByRepo's result", async () => {
		const tools = createOrchestratorTools(makeDeps());
		const result = await toolByName(tools, "dilna_usage_totals").execute(
			"call-1",
			{},
		);
		expect(JSON.parse(textOf(result))).toEqual([
			{ repoId: "repo-1", inputTokens: 10, outputTokens: 20 },
		]);
	});

	it("dilna_list_archived_sessions forwards repoId to deps.listArchivedSessions", async () => {
		const deps = makeDeps();
		const tools = createOrchestratorTools(deps);
		const result = await toolByName(
			tools,
			"dilna_list_archived_sessions",
		).execute("call-1", { repoId: "repo-1" });
		expect(deps.listArchivedSessions).toHaveBeenCalledWith("repo-1");
		expect(JSON.parse(textOf(result))).toEqual([
			{
				sessionId: "sess-old",
				repoId: "repo-1",
				title: "Old session",
				createdAt: 1,
				archivedAt: 2,
			},
		]);
	});

	it("dilna_get_archived_session returns deps.getArchivedSession's result", async () => {
		const deps = makeDeps();
		const tools = createOrchestratorTools(deps);
		const result = await toolByName(
			tools,
			"dilna_get_archived_session",
		).execute("call-1", { sessionId: "sess-old" });
		expect(deps.getArchivedSession).toHaveBeenCalledWith("sess-old");
		expect(JSON.parse(textOf(result))).toMatchObject({
			sessionId: "sess-old",
			summary: "did some things",
		});
	});

	it("dilna_create_session calls deps.createChildSession with repoId and prompt", async () => {
		const deps = makeDeps();
		const tools = createOrchestratorTools(deps);
		const result = await toolByName(tools, "dilna_create_session").execute(
			"call-1",
			{ repoId: "repo-1", prompt: "implement issue #79" },
		);
		expect(deps.createChildSession).toHaveBeenCalledWith(
			"repo-1",
			"implement issue #79",
		);
		expect(JSON.parse(textOf(result))).toMatchObject({ id: "sess-new" });
	});

	it("caps dilna_create_session at ORCHESTRATOR_MAX_SESSIONS_PER_TURN calls", async () => {
		const deps = makeDeps();
		const tools = createOrchestratorTools(deps);
		const createSession = toolByName(tools, "dilna_create_session");

		for (let i = 0; i < ORCHESTRATOR_MAX_SESSIONS_PER_TURN; i++) {
			await createSession.execute("call", { repoId: "repo-1", prompt: "x" });
		}
		expect(deps.createChildSession).toHaveBeenCalledTimes(
			ORCHESTRATOR_MAX_SESSIONS_PER_TURN,
		);

		await expect(
			createSession.execute("call", { repoId: "repo-1", prompt: "x" }),
		).rejects.toThrow(/cap reached/);
		// The rejected call never reaches deps.
		expect(deps.createChildSession).toHaveBeenCalledTimes(
			ORCHESTRATOR_MAX_SESSIONS_PER_TURN,
		);
	});

	it("a fresh createOrchestratorTools() call resets the per-turn cap", async () => {
		const deps = makeDeps();
		for (let batch = 0; batch < 2; batch++) {
			const tools = createOrchestratorTools(deps);
			const createSession = toolByName(tools, "dilna_create_session");
			for (let i = 0; i < ORCHESTRATOR_MAX_SESSIONS_PER_TURN; i++) {
				await expect(
					createSession.execute("call", { repoId: "repo-1", prompt: "x" }),
				).resolves.toBeDefined();
			}
		}
	});
});
