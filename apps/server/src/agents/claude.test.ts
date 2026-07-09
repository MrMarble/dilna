import type {
	SDKAssistantMessage,
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
	usage?: { input_tokens: number; output_tokens: number };
}): SDKAssistantMessage {
	return {
		type: "assistant",
		uuid: overrides.uuid,
		session_id: "s1",
		parent_tool_use_id: null,
		message: {
			content: overrides.text ? [{ type: "text", text: overrides.text }] : [],
			usage: overrides.usage,
		},
	} as unknown as SDKAssistantMessage;
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
		// session_status:idle still fires alongside the reconciliation.
		expect(events).toContainEqual({ type: "session_status", status: "idle" });
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
