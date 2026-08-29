import type { Message } from "@dilna/shared";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	createNormalizeState,
	dilnaMessagesToInitialState,
	extractTitleFromReply,
	normalizePiEvent,
	piMessagesToDilna,
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
