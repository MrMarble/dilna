import type { Message } from "@dilna/shared";
import {
	type AgentEvent,
	type AgentMessage,
	estimateContextTokens,
} from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { PiHandle } from "./pi";
import {
	buildInitialMessages,
	checkSessionContext,
	createNormalizeState,
	dilnaMessagesToInitialState,
	estimateSessionContext,
	extractTitleFromReply,
	normalizePiEvent,
	pickCutPoint,
	piMessagesToDilna,
	summarizeSessionForArchive,
} from "./pi";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp } as unknown as AgentMessage;
}

function assistantMessage(content: unknown[], timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp,
	} as unknown as AgentMessage;
}

function toolResultMessage(
	toolCallId: string,
	text: string,
	isError: boolean,
	timestamp: number,
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp,
	} as unknown as AgentMessage;
}

const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
	type: "toolCall" as const,
	id,
	name,
	arguments: args,
});

describe("piMessagesToDilna", () => {
	it("merges a multi-round tool-call turn into one assistant row", () => {
		const entries: AgentMessage[] = [
			userMessage("run the tests", 1_000),
			assistantMessage(
				[
					{ type: "text", text: "Running tests…" },
					toolCall("c1", "bash", { command: "npm test" }),
				],
				1_100,
			),
			toolResultMessage("c1", "3 passed", false, 1_200),
			assistantMessage([{ type: "text", text: "All green." }], 1_300),
		];

		const messages = piMessagesToDilna("s1", entries);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({
			role: "user",
			parts: [{ type: "text", text: "run the tests" }],
		});
		expect(messages[1]).toMatchObject({
			role: "assistant",
			parts: [
				{ type: "text", text: "Running tests…" },
				{
					type: "tool_call",
					callId: "c1",
					tool: "bash",
					input: { command: "npm test" },
					output: "3 passed",
					error: undefined,
				},
				{ type: "text", text: "All green." },
			],
		});
	});

	it("fills a tool_call part's output/error from the matching ToolResultMessage by toolCallId", () => {
		const entries: AgentMessage[] = [
			userMessage("delete the file", 1_000),
			assistantMessage([toolCall("c1", "bash", { command: "rm x" })], 1_100),
			toolResultMessage("c1", "permission denied", true, 1_200),
		];

		const messages = piMessagesToDilna("s1", entries);
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant?.parts[0]).toMatchObject({
			type: "tool_call",
			output: "permission denied",
			error: "permission denied",
		});
	});

	it("drops ThinkingContent from persisted history", () => {
		const entries: AgentMessage[] = [
			userMessage("hi", 1_000),
			assistantMessage(
				[
					{ type: "thinking", thinking: "let me consider this" },
					{ type: "text", text: "hello" },
				],
				1_100,
			),
		];

		const messages = piMessagesToDilna("s1", entries);
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant?.parts).toEqual([{ type: "text", text: "hello" }]);
	});

	it("orders createdAt from each entry's real timestamp, not index-based synthesis", () => {
		const entries: AgentMessage[] = [
			userMessage("first", 5_000),
			assistantMessage([{ type: "text", text: "first reply" }], 6_000),
			userMessage("second", 100_000),
			assistantMessage([{ type: "text", text: "second reply" }], 101_000),
		];

		const messages = piMessagesToDilna("s1", entries);
		expect(messages.map((m) => m.createdAt)).toEqual([5, 6, 100, 101]);
	});

	it("synthesizes a fresh id per message (pi gives nothing to key on)", () => {
		const entries: AgentMessage[] = [userMessage("hi", 1_000)];
		const messages = piMessagesToDilna("s1", entries);
		expect(messages[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("dilnaMessagesToInitialState", () => {
	it("round-trips a user row into a UserMessage", () => {
		const messages: Message[] = [
			{
				id: "m1",
				sessionId: "s1",
				role: "user",
				parts: [{ type: "text", text: "hello" }],
				createdAt: 42,
			},
		];
		const out = dilnaMessagesToInitialState(messages);
		expect(out).toEqual([
			{ role: "user", content: "hello", timestamp: 42_000 },
		]);
	});

	it("splits an assistant row with a tool_call part into an AssistantMessage plus a trailing ToolResultMessage", () => {
		const messages: Message[] = [
			{
				id: "m1",
				sessionId: "s1",
				role: "assistant",
				parts: [
					{ type: "text", text: "checking" },
					{
						type: "tool_call",
						callId: "c1",
						tool: "bash",
						input: { command: "ls" },
						output: "file.txt",
						error: undefined,
					},
				],
				createdAt: 10,
			},
		];
		const out = dilnaMessagesToInitialState(messages);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "text", text: "checking" },
				{
					type: "toolCall",
					id: "c1",
					name: "bash",
					arguments: { command: "ls" },
				},
			],
		});
		expect(out[1]).toMatchObject({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "file.txt" }],
			isError: false,
		});
	});

	it("marks a reconstructed ToolResultMessage isError when the persisted part carried an error", () => {
		const messages: Message[] = [
			{
				id: "m1",
				sessionId: "s1",
				role: "assistant",
				parts: [
					{
						type: "tool_call",
						callId: "c1",
						tool: "bash",
						input: {},
						output: "boom",
						error: "boom",
					},
				],
				createdAt: 10,
			},
		];
		const out = dilnaMessagesToInitialState(messages);
		expect(out[1]).toMatchObject({ role: "toolResult", isError: true });
	});
});

describe("extractTitleFromReply", () => {
	it("trims whitespace and strips surrounding quotes", () => {
		expect(extractTitleFromReply('  "Fix the login flow"  ')).toBe(
			"Fix the login flow",
		);
		expect(extractTitleFromReply("'Add billing'")).toBe("Add billing");
		expect(extractTitleFromReply("\u201cAdd billing\u201d")).toBe(
			"Add billing",
		);
	});

	it("preserves the body when the reply is already clean", () => {
		expect(extractTitleFromReply("Fix the login flow")).toBe(
			"Fix the login flow",
		);
	});

	it("returns null for a blank or whitespace-only reply", () => {
		expect(extractTitleFromReply("")).toBeNull();
		expect(extractTitleFromReply("   ")).toBeNull();
	});
});

describe("normalizePiEvent", () => {
	function assistant(content: unknown[]): AgentMessage {
		return assistantMessage(content, Date.now());
	}

	it("emits one message_start for the first assistant message of a turn, and none for subsequent internal rounds", () => {
		const state = createNormalizeState();
		const first = normalizePiEvent(
			{
				type: "message_start",
				message: assistant([]),
			} as unknown as AgentEvent,
			state,
		);
		const second = normalizePiEvent(
			{
				type: "message_start",
				message: assistant([]),
			} as unknown as AgentEvent,
			state,
		);
		expect(first).toEqual([
			{
				type: "message_start",
				messageId: state.currentMessageId,
				role: "assistant",
			},
		]);
		expect(second).toEqual([]);
	});

	it("ignores message_start for a non-assistant role", () => {
		const state = createNormalizeState();
		const events = normalizePiEvent(
			{
				type: "message_start",
				message: userMessage("hi", 1),
			} as unknown as AgentEvent,
			state,
		);
		expect(events).toEqual([]);
		expect(state.currentMessageId).toBeNull();
	});

	it("maps a text_delta message_update to a token event", () => {
		const state = createNormalizeState();
		state.currentMessageId = "m1";
		const events = normalizePiEvent(
			{
				type: "message_update",
				message: assistant([]),
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "Hel",
					partial: assistant([]),
				},
			} as unknown as AgentEvent,
			state,
		);
		expect(events).toEqual([{ type: "token", messageId: "m1", chunk: "Hel" }]);
	});

	it("maps a thinking_delta message_update to a thinking event", () => {
		const state = createNormalizeState();
		state.currentMessageId = "m1";
		const events = normalizePiEvent(
			{
				type: "message_update",
				message: assistant([]),
				assistantMessageEvent: {
					type: "thinking_delta",
					contentIndex: 0,
					delta: "hmm",
					partial: assistant([]),
				},
			} as unknown as AgentEvent,
			state,
		);
		expect(events).toEqual([
			{ type: "thinking", messageId: "m1", chunk: "hmm" },
		]);
	});

	it("maps tool_execution_start/end to tool_call_start/end, attributing the end by toolCallId", () => {
		const state = createNormalizeState();
		state.currentMessageId = "m1";
		const start = normalizePiEvent(
			{
				type: "tool_execution_start",
				toolCallId: "c1",
				toolName: "bash",
				args: { command: "ls" },
			} as unknown as AgentEvent,
			state,
		);
		expect(start).toEqual([
			{
				type: "tool_call_start",
				messageId: "m1",
				callId: "c1",
				tool: "bash",
				input: { command: "ls" },
			},
		]);

		const end = normalizePiEvent(
			{
				type: "tool_execution_end",
				toolCallId: "c1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "file.txt" }] },
				isError: false,
			} as unknown as AgentEvent,
			state,
		);
		expect(end).toEqual([
			{
				type: "tool_call_end",
				messageId: "m1",
				callId: "c1",
				output: "file.txt",
				error: undefined,
			},
		]);
	});

	it("resets currentMessageId on agent_end, starting the next turn fresh", () => {
		const state = createNormalizeState();
		state.currentMessageId = "m1";
		state.toolCallMessageId.set("c1", "m1");
		normalizePiEvent(
			{ type: "agent_end", messages: [] } as unknown as AgentEvent,
			state,
		);
		expect(state.currentMessageId).toBeNull();
		expect(state.toolCallMessageId.size).toBe(0);
	});
});

function dilnaMessage(
	id: string,
	role: "user" | "assistant",
	text: string,
	createdAt: number,
): Message {
	return {
		id,
		sessionId: "s1",
		role,
		parts: [{ type: "text", text }],
		createdAt,
	};
}

describe("buildInitialMessages", () => {
	const history = [
		dilnaMessage("m1", "user", "first", 1),
		dilnaMessage("m2", "assistant", "reply one", 2),
		dilnaMessage("m3", "user", "second", 3),
		dilnaMessage("m4", "assistant", "reply two", 4),
	];

	it("returns the plain reconstructed history when there is no compaction", () => {
		expect(buildInitialMessages(history, null)).toEqual(
			dilnaMessagesToInitialState(history),
		);
	});

	it("replaces everything up to and including throughMessageId with a leading summary message", () => {
		const out = buildInitialMessages(history, {
			summary: "user asked two things, both answered",
			throughMessageId: "m2",
		});
		expect(out[0]).toMatchObject({
			role: "user",
			content: expect.stringContaining("user asked two things, both answered"),
		});
		expect(out.slice(1)).toEqual(dilnaMessagesToInitialState(history.slice(2)));
	});

	it("falls back to the full raw history (plus the summary) when throughMessageId isn't found", () => {
		const out = buildInitialMessages(history, {
			summary: "stale summary",
			throughMessageId: "does-not-exist",
		});
		expect(out).toHaveLength(1 + dilnaMessagesToInitialState(history).length);
		expect(out.slice(1)).toEqual(dilnaMessagesToInitialState(history));
	});
});

describe("pickCutPoint", () => {
	it("keeps the entire history when it all fits inside keepRecentTokens", () => {
		const history = [
			dilnaMessage("m1", "user", "hi", 1),
			dilnaMessage("m2", "assistant", "hello", 2),
		];
		expect(pickCutPoint(history, 1_000_000)).toBe(0);
	});

	it("cuts older messages once the recent-token budget is exceeded, snapped to a message boundary", () => {
		const long = "x".repeat(2_000);
		const history = [
			dilnaMessage("m1", "user", long, 1),
			dilnaMessage("m2", "assistant", long, 2),
			dilnaMessage("m3", "user", long, 3),
			dilnaMessage("m4", "assistant", long, 4),
		];
		// Small enough that only the last couple of ~2000-char messages fit.
		const cutIndex = pickCutPoint(history, 700);
		expect(cutIndex).toBeGreaterThan(0);
		expect(cutIndex).toBeLessThan(history.length);
	});
});

describe("checkSessionContext", () => {
	it("reports the estimate but skips compaction when nowhere near the budget threshold", async () => {
		const messages = [{ role: "user", content: "hi", timestamp: 1 }];
		const handle = {
			kind: "pi",
			provider: "anthropic",
			model: "claude-opus-5", // 1,000,000-token context window
			agent: { state: { messages } },
		} as unknown as PiHandle;

		const history = [dilnaMessage("m1", "user", "hi", 1)];
		const result = await checkSessionContext(handle, history, null);

		expect(result.compaction).toBeNull();
		expect(result.estimate).toMatchObject({
			contextWindow: 1_000_000,
			reserveTokens: 16_384,
		});
		expect(result.estimate?.tokens).toBeGreaterThan(0);
		expect(handle.agent.state.messages).toBe(messages);
	});

	it("returns a null estimate and no compaction for a provider/model no longer in dilna's catalog, without throwing", async () => {
		const handle = {
			kind: "pi",
			provider: "anthropic",
			model: "not-a-real-model-id",
			agent: { state: { messages: [] } },
		} as unknown as PiHandle;

		const result = await checkSessionContext(
			handle,
			[dilnaMessage("m1", "user", "hi", 1)],
			null,
		);
		expect(result).toEqual({ estimate: null, compaction: null });
	});

	it("estimates against the compacted view, not raw history, once a prior compaction exists", async () => {
		// Without folding in the prior compaction, estimating against the full
		// raw history here would report roughly the same size as before that
		// compaction ever happened — this is the bug this test guards against.
		const longText = "x".repeat(50_000);
		const history = [
			dilnaMessage("m1", "user", longText, 1),
			dilnaMessage("m2", "assistant", longText, 2),
			dilnaMessage("m3", "user", "and then?", 3),
			dilnaMessage("m4", "assistant", "then this.", 4),
		];
		const handle = {
			kind: "pi",
			provider: "anthropic",
			model: "claude-opus-5",
			agent: { state: { messages: [] } },
		} as unknown as PiHandle;

		const result = await checkSessionContext(handle, history, {
			summary: "the earlier exchange, summarized",
			throughMessageId: "m2",
		});

		expect(result.compaction).toBeNull(); // nowhere near 1M tokens either way
		expect(result.estimate?.tokens).toEqual(
			estimateContextTokens(
				buildInitialMessages(history, {
					summary: "the earlier exchange, summarized",
					throughMessageId: "m2",
				}),
			).tokens,
		);
		// Sanity check that folding the compaction in actually mattered — far
		// below what the raw (uncompacted) history alone would estimate to.
		expect(result.estimate?.tokens).toBeLessThan(
			estimateContextTokens(dilnaMessagesToInitialState(history)).tokens,
		);
	});
});

describe("estimateSessionContext", () => {
	it("mirrors checkSessionContext's estimate for the same (provider, model, history, compaction)", () => {
		const history = [dilnaMessage("m1", "user", "hi", 1)];
		const result = estimateSessionContext(
			"anthropic",
			"claude-opus-5",
			history,
			null,
		);
		expect(result).toMatchObject({
			contextWindow: 1_000_000,
			reserveTokens: 16_384,
		});
		expect(result?.tokens).toBeGreaterThan(0);
	});

	it("returns null for a provider/model no longer in dilna's catalog", () => {
		expect(
			estimateSessionContext("anthropic", "not-a-real-model-id", [], null),
		).toBeNull();
	});
});

describe("summarizeSessionForArchive", () => {
	it("returns null for a session with no messages, without resolving a model", async () => {
		expect(
			await summarizeSessionForArchive("anthropic", "claude-opus-5", [], null),
		).toBeNull();
	});

	it("returns null for a provider/model no longer in dilna's catalog", async () => {
		const history = [dilnaMessage("m1", "user", "hi", 1)];
		expect(
			await summarizeSessionForArchive(
				"anthropic",
				"not-a-real-model-id",
				history,
				null,
			),
		).toBeNull();
	});

	it("returns the prior compaction's summary verbatim, with no LLM call, when nothing happened after its cutoff", async () => {
		const history = [
			dilnaMessage("m1", "user", "hi", 1),
			dilnaMessage("m2", "assistant", "hello", 2),
		];
		const summary = await summarizeSessionForArchive(
			"anthropic",
			"claude-opus-5",
			history,
			{ summary: "already fully summarized", throughMessageId: "m2" },
		);
		expect(summary).toBe("already fully summarized");
	});
});
