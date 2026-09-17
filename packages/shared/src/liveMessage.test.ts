import { describe, expect, it } from "vitest";
import type { AgentStreamEvent } from "./events";
import { applyEventToParts, isMessageContentEvent } from "./liveMessage";
import type { MessagePart } from "./messages";

const fold = (events: AgentStreamEvent[]): MessagePart[] =>
	events.reduce<MessagePart[]>(applyEventToParts, []);

const toolStart = (
	callId: string,
	tool = "Bash",
	input: unknown = {},
): AgentStreamEvent => ({
	type: "tool_call_start",
	messageId: "m1",
	callId,
	tool,
	input,
});

const token = (chunk: string): AgentStreamEvent => ({
	type: "token",
	messageId: "m1",
	chunk,
});

/** An image the Agent sent mid-turn (issue #222, ADR-0038). */
const sentImage = {
	id: "img-1",
	sessionId: "s1",
	filename: "shot.png",
	mimeType: "image/png",
	size: 128,
	kind: "image" as const,
	source: "agent" as const,
	path: "/data/attachments/s1/aa-shot.png",
	createdAt: 41,
};

const imageSent = (): AgentStreamEvent => ({
	type: "image_sent",
	messageId: "m1",
	attachment: sentImage,
});

describe("applyEventToParts (image_sent)", () => {
	// Issue #222/ADR-0038: the picture has to land *between* the prose that
	// introduces it and the prose that interprets it. Appending at the end of
	// the turn (or hoisting to the top) would put every image next to the wrong
	// sentence.
	it("keeps an Agent-sent image in the position it was sent", () => {
		const parts = fold([
			token("Here's the homepage:"),
			imageSent(),
			token("The header is fixed."),
		]);

		expect(parts).toEqual([
			{ type: "text", text: "Here's the homepage:" },
			{ type: "attachment", attachment: sentImage },
			{ type: "text", text: "The header is fixed." },
		]);
	});

	it("opens a fresh text part for a token that follows an image", () => {
		const parts = fold([token("before"), imageSent(), token("after")]);
		expect(parts.filter((p) => p.type === "text")).toEqual([
			{ type: "text", text: "before" },
			{ type: "text", text: "after" },
		]);
	});

	it("interleaves images with tool calls in stream order", () => {
		const parts = fold([
			toolStart("c1", "Bash", { command: "screenshot" }),
			{ type: "tool_call_end", messageId: "m1", callId: "c1", output: "ok" },
			imageSent(),
			token("done"),
		]);

		expect(parts.map((p) => p.type)).toEqual([
			"tool_call",
			"attachment",
			"text",
		]);
	});

	it("appends each of several images separately", () => {
		const second = {
			...sentImage,
			id: "img-2",
			filename: "after.png",
		};
		const parts = fold([
			imageSent(),
			{ type: "image_sent", messageId: "m1", attachment: second },
		]);

		expect(parts).toEqual([
			{ type: "attachment", attachment: sentImage },
			{ type: "attachment", attachment: second },
		]);
	});
});

describe("applyEventToParts", () => {
	it("joins consecutive token chunks into one trailing text part", () => {
		expect(fold([token("Hel"), token("lo "), token("world")])).toEqual([
			{ type: "text", text: "Hello world" },
		]);
	});

	it("opens a new text part for a token that follows a tool call, preserving interleaving order", () => {
		const parts = fold([
			token("checking"),
			toolStart("c1", "Bash", { command: "ls" }),
			{ type: "tool_call_end", messageId: "m1", callId: "c1", output: "ok" },
			token("done"),
		]);

		expect(parts).toEqual([
			{ type: "text", text: "checking" },
			{
				type: "tool_call",
				callId: "c1",
				tool: "Bash",
				input: { command: "ls" },
				output: "ok",
				error: undefined,
			},
			{ type: "text", text: "done" },
		]);
	});

	it("leaves a tool call unresolved (output null) until its end event arrives", () => {
		const parts = fold([toolStart("c1")]);
		expect(parts).toEqual([
			{
				type: "tool_call",
				callId: "c1",
				tool: "Bash",
				input: {},
				output: null,
			},
		]);
	});

	it("fills the matching tool_call part in place rather than appending", () => {
		const parts = fold([
			toolStart("c1", "Read"),
			toolStart("c2", "Edit"),
			{ type: "tool_call_end", messageId: "m1", callId: "c1", output: "file" },
		]);

		expect(parts).toHaveLength(2);
		expect(parts[0]).toMatchObject({ callId: "c1", output: "file" });
		// The still-running second call is untouched.
		expect(parts[1]).toMatchObject({ callId: "c2", output: null });
	});

	it("carries an errored tool result onto its part", () => {
		const parts = fold([
			toolStart("c1"),
			{
				type: "tool_call_end",
				messageId: "m1",
				callId: "c1",
				output: "boom",
				error: "boom",
			},
		]);
		expect(parts[0]).toMatchObject({ output: "boom", error: "boom" });
	});

	it("ignores a tool_call_end whose callId matches nothing", () => {
		const parts = fold([
			toolStart("c1"),
			{ type: "tool_call_end", messageId: "m1", callId: "nope", output: "x" },
		]);
		expect(parts[0]).toMatchObject({ callId: "c1", output: null });
	});

	// Identity, not just equality: both consumers rely on an unchanged
	// reference to skip a state update (React bail-out on the client, and the
	// server's snapshot pass-through).
	it.each([
		["session_status", { type: "session_status", status: "working" }],
		[
			"message_start",
			{ type: "message_start", messageId: "m1", role: "assistant" },
		],
		["message_end", { type: "message_end", messageId: "m1" }],
		["thinking", { type: "thinking", messageId: "m1", chunk: "hmm" }],
		["notice", { type: "notice", message: "reconnected" }],
		[
			"turn_failed",
			{ type: "turn_failed", class: "turn_error", message: "nope" },
		],
	] as const)("returns the same parts reference for %s", (_label, ev) => {
		const parts: MessagePart[] = [{ type: "text", text: "hi" }];
		expect(applyEventToParts(parts, ev as AgentStreamEvent)).toBe(parts);
	});

	it("never mutates the parts array it is given", () => {
		const parts: MessagePart[] = [{ type: "text", text: "hi" }];
		const frozen = Object.freeze([...parts]) as MessagePart[];
		expect(() => applyEventToParts(frozen, token(" there"))).not.toThrow();
		expect(frozen).toEqual([{ type: "text", text: "hi" }]);
	});
});

describe("isMessageContentEvent", () => {
	it.each([
		"token",
		"tool_call_start",
		"tool_call_end",
	] as const)("accepts %s", (type) => {
		expect(isMessageContentEvent({ type } as unknown as AgentStreamEvent)).toBe(
			true,
		);
	});

	it("accepts image_sent", () => {
		expect(isMessageContentEvent(imageSent())).toBe(true);
	});

	it.each([
		"session_status",
		"message_start",
		"message_end",
		"thinking",
		"notice",
		"turn_failed",
		"turn_activity",
		"user_message",
		"changed_files",
		"artefact_published",
	] as const)("rejects %s", (type) => {
		expect(isMessageContentEvent({ type } as unknown as AgentStreamEvent)).toBe(
			false,
		);
	});

	/** Guards the pairing the two functions rely on: anything
	 * `isMessageContentEvent` accepts must be something `applyEventToParts`
	 * actually acts on, or a consumer would create an empty live entry for an
	 * event that then contributes nothing to it. */
	it("accepts exactly the events applyEventToParts acts on", () => {
		const samples: AgentStreamEvent[] = [
			token("x"),
			toolStart("c1"),
			imageSent(),
			{ type: "tool_call_end", messageId: "m1", callId: "c1", output: "y" },
			{ type: "session_status", status: "idle" },
			{ type: "message_start", messageId: "m1", role: "assistant" },
			{ type: "message_end", messageId: "m1" },
			{ type: "thinking", messageId: "m1", chunk: "hmm" },
			{ type: "notice", message: "n" },
		];

		for (const ev of samples) {
			const base: MessagePart[] = [
				{
					type: "tool_call",
					callId: "c1",
					tool: "Bash",
					input: {},
					output: null,
				},
			];
			const changed = applyEventToParts(base, ev) !== base;
			expect(changed).toBe(isMessageContentEvent(ev));
		}
	});
});
