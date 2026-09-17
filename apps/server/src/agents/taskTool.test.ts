/**
 * biome-ignore-all lint/suspicious/noExplicitAny: this file stands in for
 * pi-agent-core's `Agent` and several tool factories with structural fakes.
 * Reproducing their real generic signatures would assert the library's types
 * rather than dilna's behaviour, which is what these tests are about.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The child `Agent` is mocked wholesale: these tests are about the *contract*
 * the task tool builds a subagent under (which tools it gets, what it returns,
 * how the cap and activity reporting behave), none of which needs a real
 * provider call.
 */
const constructed: {
	options: any;
	promptCalls: string[];
	aborted: boolean;
}[] = [];

let promptImpl: (agent: any, prompt: string) => void = (agent) => {
	agent.state.messages.push({
		role: "assistant",
		content: [{ type: "text", text: "the answer" }],
	});
};

vi.mock("@earendil-works/pi-agent-core", () => ({
	Agent: class {
		state: any;
		private listeners = new Set<(event: any) => void>();
		record: (typeof constructed)[number];
		constructor(options: any) {
			this.state = {
				messages: [...(options.initialState?.messages ?? [])],
				tools: options.initialState?.tools ?? [],
			};
			this.record = { options, promptCalls: [], aborted: false };
			constructed.push(this.record);
		}
		subscribe(listener: (event: any) => void) {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		}
		emit(event: any) {
			for (const l of this.listeners) l(event);
		}
		async prompt(input: string) {
			this.record.promptCalls.push(input);
			promptImpl(this, input);
		}
		abort() {
			this.record.aborted = true;
		}
	},
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	createReadTool: () => ({ name: "read" }),
	createGrepTool: () => ({ name: "grep" }),
	createFindTool: () => ({ name: "find" }),
	createLsTool: () => ({ name: "ls" }),
}));

vi.mock("./webFetchTool", () => ({
	createWebFetchTool: () => ({ name: "web_fetch" }),
}));

vi.mock("./confinement", () => ({
	createConfinementHook: vi.fn(() => async () => undefined),
}));

import { createConfinementHook } from "./confinement";
import {
	createTaskTool,
	MAX_TASKS_PER_TURN,
	type RunningTask,
} from "./taskTool";

const model = { id: "test-model", api: "anthropic" } as unknown as Model<Api>;

function makeTool(onTasksChanged: (tasks: RunningTask[]) => void = () => {}) {
	return createTaskTool({
		worktreePath: "/wt",
		sessionId: "sess-1",
		extraReadablePaths: ["/attachments/sess-1"],
		model,
		getApiKey: async () => "key",
		onTasksChanged,
	});
}

function textOf(result: any): string {
	return result.content.map((c: any) => c.text ?? "").join("");
}

beforeEach(() => {
	constructed.length = 0;
	promptImpl = (agent) => {
		agent.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "the answer" }],
		});
	};
});

describe("createTaskTool", () => {
	it("returns the subagent's final assistant text as the tool result", async () => {
		const { tool } = makeTool();
		const result = await tool.execute("call-1", {
			description: "Find it",
			prompt: "where is the thing",
		});
		expect(textOf(result)).toBe("the answer");
		expect(constructed[0]?.promptCalls).toEqual(["where is the thing"]);
	});

	// The core safety property of ADR-0034: a subagent shares the parent's
	// Worktree, so it must not be able to mutate it.
	it("gives the subagent read-only tools and no nested task tool", async () => {
		const { tool } = makeTool();
		await tool.execute("call-1", { description: "d", prompt: "p" });

		const names = (constructed[0]?.options.initialState.tools ?? []).map(
			(t: any) => t.name,
		);
		expect(names.sort()).toEqual(
			["find", "grep", "ls", "read", "web_fetch"].sort(),
		);
		for (const forbidden of [
			"write",
			"edit",
			"bash",
			"task",
			"dilna_publish_artefact",
			// Issue #222/ADR-0038: same reasoning as the publish tool — a subagent
			// reports to its parent, not to the user's transcript.
			"dilna_send_image",
			"update_repo_memory",
		]) {
			expect(names).not.toContain(forbidden);
		}
	});

	it("starts the subagent with an empty context, not the parent's history", async () => {
		const { tool } = makeTool();
		await tool.execute("call-1", { description: "d", prompt: "p" });
		expect(constructed[0]?.options.initialState.messages).toEqual([]);
	});

	it("confines the subagent to the worktree and inherits the parent's model", async () => {
		const { tool } = makeTool();
		await tool.execute("call-1", { description: "d", prompt: "p" });

		expect(createConfinementHook).toHaveBeenCalledWith("/wt", [
			"/attachments/sess-1",
		]);
		expect(constructed[0]?.options.beforeToolCall).toBeDefined();
		expect(constructed[0]?.options.initialState.model).toBe(model);
	});

	it("reports running tasks while in flight and clears them afterwards", async () => {
		const snapshots: RunningTask[][] = [];
		const { tool } = makeTool((tasks) => snapshots.push(tasks));

		promptImpl = (agent) => {
			agent.emit({ type: "tool_execution_start", toolName: "grep" });
			agent.state.messages.push({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			});
		};

		await tool.execute("call-42", { description: "Find auth", prompt: "p" });

		const running = snapshots.find((s) => s.length === 1);
		expect(running?.[0]).toMatchObject({
			description: "Find auth",
			toolUseId: "call-42",
		});
		// A tool_execution_start advanced the counter...
		expect(snapshots.some((s) => s[0]?.lastTool === "grep")).toBe(true);
		// ...and the final snapshot is empty, so the UI line disappears.
		expect(snapshots.at(-1)).toEqual([]);
	});

	it("caps tasks per turn and resets the cap at the next turn", async () => {
		const { tool, resetTurn } = makeTool();
		const params = { description: "d", prompt: "p" };

		for (let i = 0; i < MAX_TASKS_PER_TURN; i++) {
			const ok = await tool.execute(`call-${i}`, params);
			expect(textOf(ok)).toBe("the answer");
		}

		// Past the cap: no subagent is constructed, and the model is told why in
		// the result text (a returned `isError` would be dropped by the loop).
		const capped = await tool.execute("call-over", params);
		expect(textOf(capped)).toContain("Task limit reached");
		expect(constructed).toHaveLength(MAX_TASKS_PER_TURN);

		resetTurn();
		const afterReset = await tool.execute("call-next-turn", params);
		expect(textOf(afterReset)).toBe("the answer");
		expect(constructed).toHaveLength(MAX_TASKS_PER_TURN + 1);
	});

	it("reports a subagent failure as an error result instead of failing the turn", async () => {
		const { tool } = makeTool();
		promptImpl = () => {
			throw new Error("provider exploded");
		};

		// Returned, not thrown: throwing would fail the parent's whole turn,
		// when the parent can simply do the investigation itself instead.
		const result = await tool.execute("call-1", {
			description: "d",
			prompt: "p",
		});
		expect(textOf(result)).toContain("provider exploded");
		expect(textOf(result)).toContain("Investigate directly instead");
	});

	it("surfaces an empty subagent response rather than returning blank text", async () => {
		const { tool } = makeTool();
		promptImpl = () => {};

		const result = await tool.execute("call-1", {
			description: "d",
			prompt: "p",
		});
		expect(textOf(result)).toContain("no output");
	});

	it("aborts the subagent when the parent turn is stopped", async () => {
		const { tool } = makeTool();
		const controller = new AbortController();
		promptImpl = (agent) => {
			controller.abort();
			agent.state.messages.push({
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
			});
		};

		const result = await tool.execute(
			"call-1",
			{ description: "d", prompt: "p" },
			controller.signal,
		);

		expect(constructed[0]?.aborted).toBe(true);
		expect(textOf(result)).toContain("stopped");
	});
});
