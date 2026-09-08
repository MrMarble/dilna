import { describe, expect, it } from "vitest";
import {
	applyEventToLive,
	type LiveMessage,
	type MessageContentEvent,
} from "./live-messages";

const at = () => 1_700_000_000;

const token = (messageId: string, chunk: string): MessageContentEvent => ({
	type: "token",
	messageId,
	chunk,
});

const toolStart = (messageId: string, callId: string): MessageContentEvent => ({
	type: "tool_call_start",
	messageId,
	callId,
	tool: "Bash",
	input: { command: "ls" },
});

const toolEnd = (
	messageId: string,
	callId: string,
	output: unknown = "ok",
): MessageContentEvent => ({
	type: "tool_call_end",
	messageId,
	callId,
	output,
});

const existing = (
	id: string,
	parts: LiveMessage["parts"] = [],
): LiveMessage => ({
	id,
	role: "assistant",
	parts,
	startedAt: 1_600_000_000,
});

/** Narrows away `noUncheckedIndexedAccess`'s `undefined` while asserting the
 * entry was actually created — the thing most of these cases are about. */
function entry(live: Record<string, LiveMessage>, id: string): LiveMessage {
	const m = live[id];
	if (!m) throw new Error(`expected a live entry for ${id}`);
	return m;
}

describe("applyEventToLive", () => {
	it("accumulates parts onto the addressed message only", () => {
		const live = { m1: existing("m1"), m2: existing("m2") };
		const next = applyEventToLive(live, token("m1", "hi"), at);

		expect(entry(next, "m1").parts).toEqual([{ type: "text", text: "hi" }]);
		// Untouched entries keep their identity, so their subtrees don't re-render.
		expect(next.m2).toBe(live.m2);
	});

	it("preserves an existing message's startedAt rather than restamping it", () => {
		const live = { m1: existing("m1") };
		const next = applyEventToLive(live, token("m1", "hi"), at);
		expect(entry(next, "m1").startedAt).toBe(1_600_000_000);
	});

	describe("a message this tab never saw start (connected mid-turn)", () => {
		it("creates the entry for a token", () => {
			const next = applyEventToLive({}, token("m9", "resuming"), at);

			expect(entry(next, "m9")).toEqual({
				id: "m9",
				role: "assistant",
				parts: [{ type: "text", text: "resuming" }],
				startedAt: at(),
			});
		});

		it("creates the entry for a tool_call_start, so a tool-heavy turn still renders", () => {
			const next = applyEventToLive({}, toolStart("m9", "c1"), at);

			expect(entry(next, "m9").parts).toEqual([
				{
					type: "tool_call",
					callId: "c1",
					tool: "Bash",
					input: { command: "ls" },
					output: null,
				},
			]);
		});

		it("drops a tool_call_end, rather than inventing a call that was never shown", () => {
			const live = {};
			expect(applyEventToLive(live, toolEnd("m9", "c1"), at)).toBe(live);
		});
	});

	it("resolves a tool call in place on its end event", () => {
		const opened = applyEventToLive({}, toolStart("m1", "c1"), at);
		const closed = applyEventToLive(opened, toolEnd("m1", "c1", "files"), at);

		expect(entry(closed, "m1").parts).toHaveLength(1);
		expect(entry(closed, "m1").parts[0]).toMatchObject({
			callId: "c1",
			output: "files",
		});
	});

	it("returns the same map reference when a tool_call_end matches no part", () => {
		const live = { m1: existing("m1", [{ type: "text", text: "hi" }]) };
		expect(applyEventToLive(live, toolEnd("m1", "nope"), at)).toBe(live);
	});

	it("renders a full interleaved turn in stream order", () => {
		const events: MessageContentEvent[] = [
			token("m1", "Check"),
			token("m1", "ing…"),
			toolStart("m1", "c1"),
			toolEnd("m1", "c1", "ok"),
			token("m1", "done"),
		];
		const live = events.reduce<Record<string, LiveMessage>>(
			(acc, ev) => applyEventToLive(acc, ev, at),
			{},
		);

		expect(entry(live, "m1").parts).toEqual([
			{ type: "text", text: "Checking…" },
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

	it("never mutates the map or the message it was given", () => {
		const live = { m1: existing("m1", [{ type: "text", text: "hi" }]) };
		const snapshot = JSON.parse(JSON.stringify(live));
		applyEventToLive(live, token("m1", " there"), at);
		expect(live).toEqual(snapshot);
	});
});
