import type { Message } from "@dilna/shared";
import { describe, expect, it } from "vitest";
import { summarizeEditCalls } from "./editBenchMetrics";

/** Build an assistant row carrying one tool_call part, the shape
 * `piRoundToDilnaMessage` persists. */
function toolCall(
	callId: string,
	tool: string,
	input: unknown,
	opts: { error?: string; output?: unknown } = {},
): Message {
	return {
		id: `m-${callId}`,
		sessionId: "s-1",
		role: "assistant",
		createdAt: 1_700_000_000,
		turnId: "t-1",
		parts: [
			{
				type: "tool_call",
				callId,
				tool: tool as never,
				input,
				output: opts.output ?? "",
				...(opts.error === undefined ? {} : { error: opts.error }),
			},
		],
	};
}

describe("summarizeEditCalls", () => {
	it("counts a clean single edit as one attempt and no retries", () => {
		const messages = [
			toolCall("c1", "edit", {
				path: "src/a.ts",
				edits: [{ oldText: "foo", newText: "bar" }],
			}),
		];

		expect(summarizeEditCalls(messages)).toEqual({
			attempts: 1,
			failures: 0,
			retries: 0,
			filesTouched: 1,
		});
	});

	it("counts a failed edit followed by a success on the same file as one retry", () => {
		const messages = [
			toolCall(
				"c1",
				"edit",
				{ path: "src/a.ts", edits: [{ oldText: "foo", newText: "bar" }] },
				{ error: "oldText not found" },
			),
			toolCall("c2", "edit", {
				path: "src/a.ts",
				edits: [{ oldText: "foo!", newText: "bar" }],
			}),
		];

		expect(summarizeEditCalls(messages)).toEqual({
			attempts: 2,
			failures: 1,
			retries: 1,
			filesTouched: 1,
		});
	});

	it("counts edits to three different files as three attempts and no retries", () => {
		const messages = [
			toolCall("c1", "edit", { path: "src/a.ts", edits: [] }),
			toolCall("c2", "edit", { path: "src/b.ts", edits: [] }),
			toolCall("c3", "edit", { path: "src/c.ts", edits: [] }),
		];

		expect(summarizeEditCalls(messages)).toEqual({
			attempts: 3,
			failures: 0,
			retries: 0,
			filesTouched: 3,
		});
	});

	it("ignores non-edit tool calls", () => {
		const messages = [
			toolCall("c1", "read", { path: "src/a.ts" }),
			toolCall("c2", "bash", { command: "ls" }),
			toolCall("c3", "edit", { path: "src/a.ts", edits: [] }),
			toolCall("c4", "grep", { pattern: "foo" }),
		];

		expect(summarizeEditCalls(messages)).toEqual({
			attempts: 1,
			failures: 0,
			retries: 0,
			filesTouched: 1,
		});
	});
});
