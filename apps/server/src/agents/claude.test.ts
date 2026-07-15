import type {
	SDKAssistantMessage,
	SDKPartialAssistantMessage,
	SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { createNormalizeState, normalizeMessage } from "./claude";

// Minimal fixtures — only the fields normalizeMessage actually reads.
// Cast through `unknown` rather than satisfying the SDK's full (large,
// unstable) message shape.
function assistantMessage(overrides: {
	uuid: string;
	text?: string;
	apiId?: string;
	usage?: { input_tokens: number; output_tokens: number };
}): SDKAssistantMessage {
	return {
		type: "assistant",
		uuid: overrides.uuid,
		session_id: "s1",
		parent_tool_use_id: null,
		message: {
			id: overrides.apiId,
			content: overrides.text ? [{ type: "text", text: overrides.text }] : [],
			usage: overrides.usage,
		},
	} as unknown as SDKAssistantMessage;
}

function streamMessageStart(overrides: {
	uuid: string;
	apiId: string;
}): SDKPartialAssistantMessage {
	return {
		type: "stream_event",
		uuid: overrides.uuid,
		session_id: "s1",
		parent_tool_use_id: null,
		event: { type: "message_start", message: { id: overrides.apiId } },
	} as unknown as SDKPartialAssistantMessage;
}

function streamTextDelta(overrides: {
	uuid: string;
	text: string;
}): SDKPartialAssistantMessage {
	return {
		type: "stream_event",
		uuid: overrides.uuid,
		session_id: "s1",
		parent_tool_use_id: null,
		event: {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: overrides.text },
		},
	} as unknown as SDKPartialAssistantMessage;
}

function resultMessage(overrides: {
	uuid: string;
	subtype?: "success" | "error_during_execution";
	usage: { input_tokens: number; output_tokens: number };
}): SDKResultMessage {
	return {
		type: "result",
		subtype: overrides.subtype ?? "success",
		uuid: overrides.uuid,
		session_id: "s1",
		usage: overrides.usage,
		errors: [],
	} as unknown as SDKResultMessage;
}

describe("normalizeMessage usage_update", () => {
	it("emits a per-message usage delta from an assistant message's usage", () => {
		const state = createNormalizeState();
		const events = normalizeMessage(
			assistantMessage({
				uuid: "m1",
				text: "hi",
				usage: { input_tokens: 10, output_tokens: 5 },
			}),
			state,
		);
		const usageEvents = events.filter((e) => e.type === "usage_update");
		expect(usageEvents).toEqual([
			{
				type: "usage_update",
				messageId: "m1",
				usage: { inputTokens: 10, outputTokens: 5 },
			},
		]);
	});

	it("does not emit usage_update when the assistant message has no usage object", () => {
		const state = createNormalizeState();
		const events = normalizeMessage(
			assistantMessage({ uuid: "m1", text: "hi" }),
			state,
		);
		expect(events.some((e) => e.type === "usage_update")).toBe(false);
	});

	it("emits a reconciling cumulative usage_update on a successful result, pinned to the turn's messageId", () => {
		const state = createNormalizeState();
		normalizeMessage(
			assistantMessage({
				uuid: "m1",
				text: "hi",
				usage: { input_tokens: 10, output_tokens: 5 },
			}),
			state,
		);
		// A second API call within the same turn (tool round-trip) reuses the
		// first uuid as the pinned turn messageId internally.
		normalizeMessage(
			assistantMessage({
				uuid: "m2",
				text: "more",
				usage: { input_tokens: 20, output_tokens: 8 },
			}),
			state,
		);
		const events = normalizeMessage(
			resultMessage({
				uuid: "r1",
				usage: { input_tokens: 30, output_tokens: 13 },
			}),
			state,
		);
		const usageEvent = events.find((e) => e.type === "usage_update");
		expect(usageEvent).toEqual({
			type: "usage_update",
			messageId: "m1",
			usage: { inputTokens: 30, outputTokens: 13 },
			cumulative: { inputTokens: 30, outputTokens: 13 },
		});
		// No session_status here — only SessionManager may emit that (ADR-0016
		// §1); a successful result carries no turn_failed either.
		expect(events.some((e) => e.type === "session_status")).toBe(false);
		expect(events.some((e) => e.type === "turn_failed")).toBe(false);
	});

	it("falls back to the result message's own uuid when no assistant message started the turn", () => {
		const state = createNormalizeState();
		const events = normalizeMessage(
			resultMessage({
				uuid: "r1",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
			state,
		);
		const usageEvent = events.find((e) => e.type === "usage_update");
		expect(usageEvent).toMatchObject({ messageId: "r1" });
	});

	it("resets the turn messageId after a result so the next turn gets a fresh id", () => {
		const state = createNormalizeState();
		normalizeMessage(assistantMessage({ uuid: "m1", text: "hi" }), state);
		normalizeMessage(
			resultMessage({
				uuid: "r1",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
			state,
		);
		const events = normalizeMessage(
			assistantMessage({ uuid: "m2", text: "next turn" }),
			state,
		);
		expect(events).toContainEqual({
			type: "message_start",
			messageId: "m2",
			role: "assistant",
		});
	});
});

describe("normalizeMessage stream_event (partial messages)", () => {
	it("opens the turn message on message_start and pins the turn id to it", () => {
		const state = createNormalizeState();
		const events = normalizeMessage(
			streamMessageStart({ uuid: "se1", apiId: "msg_1" }),
			state,
		);
		expect(events).toEqual([
			{ type: "message_start", messageId: "se1", role: "assistant" },
		]);
	});

	it("emits token events from text deltas under the pinned turn id", () => {
		const state = createNormalizeState();
		normalizeMessage(
			streamMessageStart({ uuid: "se1", apiId: "msg_1" }),
			state,
		);
		const events = normalizeMessage(
			streamTextDelta({ uuid: "se2", text: "Hel" }),
			state,
		);
		expect(events).toEqual([{ type: "token", messageId: "se1", chunk: "Hel" }]);
	});

	it("skips the complete assistant message's text when its API id already streamed as deltas", () => {
		const state = createNormalizeState();
		normalizeMessage(
			streamMessageStart({ uuid: "se1", apiId: "msg_1" }),
			state,
		);
		normalizeMessage(streamTextDelta({ uuid: "se2", text: "Hello" }), state);
		const events = normalizeMessage(
			assistantMessage({
				uuid: "m1",
				apiId: "msg_1",
				text: "Hello",
				usage: { input_tokens: 3, output_tokens: 2 },
			}),
			state,
		);
		// No duplicate token or message_start — but usage still flows through,
		// attributed to the turn id pinned by the stream events.
		expect(events).toEqual([
			{
				type: "usage_update",
				messageId: "se1",
				usage: { inputTokens: 3, outputTokens: 2 },
			},
		]);
	});

	it("still emits text from a complete assistant message that never streamed deltas", () => {
		const state = createNormalizeState();
		normalizeMessage(
			streamMessageStart({ uuid: "se1", apiId: "msg_1" }),
			state,
		);
		const events = normalizeMessage(
			assistantMessage({ uuid: "m2", apiId: "msg_other", text: "plain" }),
			state,
		);
		expect(events).toContainEqual({
			type: "token",
			messageId: "se1",
			chunk: "plain",
		});
	});

	it("does not re-emit message_start for a second API message in the same turn", () => {
		const state = createNormalizeState();
		normalizeMessage(
			streamMessageStart({ uuid: "se1", apiId: "msg_1" }),
			state,
		);
		const events = normalizeMessage(
			streamMessageStart({ uuid: "se9", apiId: "msg_2" }),
			state,
		);
		expect(events).toEqual([]);
	});

	it("clears streamed API ids at end of turn so a reused id streams again next turn", () => {
		const state = createNormalizeState();
		normalizeMessage(
			streamMessageStart({ uuid: "se1", apiId: "msg_1" }),
			state,
		);
		normalizeMessage(
			resultMessage({
				uuid: "r1",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
			state,
		);
		const events = normalizeMessage(
			assistantMessage({ uuid: "m2", apiId: "msg_1", text: "next" }),
			state,
		);
		expect(events).toContainEqual({
			type: "token",
			messageId: "m2",
			chunk: "next",
		});
	});
});
