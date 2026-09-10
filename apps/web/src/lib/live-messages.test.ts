import type { Message } from "@dilna/shared";
import { describe, expect, it } from "vitest";
import {
	applyEventToLive,
	foldTurnRows,
	type LiveMessage,
	type MessageContentEvent,
	mergeRenderedMessages,
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

/**
 * ADR-0026 §3 persists one row per pi-agent-core round, so a tool-heavy turn
 * reloads as several consecutive rows. `foldTurnRows` regroups them into the
 * single message the live view already renders — the regression this exists
 * to fix (the chat used to collapse tool calls correctly while streaming, then
 * split into one message per round the moment history was fetched).
 */
describe("foldTurnRows", () => {
	const row = (
		id: string,
		parts: Message["parts"],
		turnId: string | null,
		role: Message["role"] = "assistant",
	): Message => ({
		id,
		sessionId: "s1",
		role,
		parts,
		createdAt: 1_700_000_000,
		turnId,
	});

	it("merges consecutive rows sharing a turnId into one message", () => {
		const folded = foldTurnRows([
			row("u1", [{ type: "text", text: "run the tests" }], null, "user"),
			row("a1", [{ type: "text", text: "Running…" }], "t1"),
			row(
				"a2",
				[
					{
						type: "tool_call",
						callId: "c1",
						tool: "Bash",
						input: {},
						output: "ok",
					},
				],
				"t1",
			),
			row("a3", [{ type: "text", text: "All green." }], "t1"),
		]);

		expect(folded.map((m) => m.id)).toEqual(["u1", "a1"]);
		// The turn's text and tool calls end up adjacent in one parts array,
		// which is what lets ToolCallGroup group them again.
		expect(folded[1]?.parts).toEqual([
			{ type: "text", text: "Running…" },
			{
				type: "tool_call",
				callId: "c1",
				tool: "Bash",
				input: {},
				output: "ok",
			},
			{ type: "text", text: "All green." },
		]);
	});

	it("keeps the first row's id and createdAt as the folded message's", () => {
		const folded = foldTurnRows([
			{ ...row("a1", [{ type: "text", text: "one" }], "t1"), createdAt: 111 },
			{ ...row("a2", [{ type: "text", text: "two" }], "t1"), createdAt: 222 },
		]);

		expect(folded).toHaveLength(1);
		expect(folded[0]?.id).toBe("a1");
		expect(folded[0]?.createdAt).toBe(111);
	});

	it("does not merge two different turns", () => {
		const folded = foldTurnRows([
			row("a1", [{ type: "text", text: "first turn" }], "t1"),
			row("a2", [{ type: "text", text: "second turn" }], "t2"),
		]);

		expect(folded.map((m) => m.id)).toEqual(["a1", "a2"]);
	});

	it("never merges null-turnId rows together", () => {
		// Pre-migration rows and user rows both carry null — coalescing them
		// would merge unrelated messages into one.
		const folded = foldTurnRows([
			row("a1", [{ type: "text", text: "legacy one" }], null),
			row("a2", [{ type: "text", text: "legacy two" }], null),
			row("a3", [{ type: "text", text: "legacy three" }], null),
		]);

		expect(folded.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
	});

	it("does not merge a turn's rows across an intervening message", () => {
		const folded = foldTurnRows([
			row("a1", [{ type: "text", text: "turn one" }], "t1"),
			row("u2", [{ type: "text", text: "user interjects" }], null, "user"),
			row("a3", [{ type: "text", text: "turn one, resumed" }], "t1"),
		]);

		expect(folded.map((m) => m.id)).toEqual(["a1", "u2", "a3"]);
	});

	it("leaves a single-row turn and an empty list alone", () => {
		const single = [row("a1", [{ type: "text", text: "solo" }], "t1")];
		expect(foldTurnRows(single).map((m) => m.id)).toEqual(["a1"]);
		expect(foldTurnRows([])).toEqual([]);
	});

	it("does not mutate the rows it was given", () => {
		const rows = [
			row("a1", [{ type: "text", text: "one" }], "t1"),
			row("a2", [{ type: "text", text: "two" }], "t1"),
		];
		const snapshot = JSON.parse(JSON.stringify(rows));

		foldTurnRows(rows);

		expect(rows).toEqual(snapshot);
	});

	it("preserves each row's sessionId on the folded message", () => {
		// The fold returns `Message[]`, so the identity fields the renderer
		// doesn't read must survive it rather than being dropped by a local
		// shape.
		const folded = foldTurnRows([
			{ ...row("a1", [{ type: "text", text: "one" }], "t1"), sessionId: "sX" },
			{ ...row("a2", [{ type: "text", text: "two" }], "t1"), sessionId: "sX" },
		]);

		expect(folded).toHaveLength(1);
		expect(folded[0]?.sessionId).toBe("sX");
	});
});

/**
 * The join the regression actually happened at. `foldTurnRows` is only half
 * the story: what the user saw break was `ChatShell` reconciling its live
 * entries against persisted history and ending up with N messages per turn.
 * These drive the real pipeline — persisted rows + live entries → rendered
 * list — which is where the grouping must survive the handoff.
 */
describe("mergeRenderedMessages", () => {
	const sessionId = "s1";

	const persisted = (
		id: string,
		turnId: string | null,
		text: string,
		role: Message["role"] = "assistant",
		createdAt = 1_700_000_000,
	): Message => ({
		id,
		sessionId,
		role,
		parts: [{ type: "text", text }],
		turnId,
		createdAt,
	});

	const live = (
		id: string,
		text: string,
		role: LiveMessage["role"] = "assistant",
		startedAt = 1_700_000_000,
	): LiveMessage => ({
		id,
		role,
		parts: [{ type: "text", text }],
		startedAt,
	});

	it("regroups a post-turn reconcile into one message (the reported bug)", () => {
		// Exactly what the DB holds after a turn that called tools across three
		// rounds, plus the user's own row — the state `loadHistory()` fetches
		// the moment the turn goes idle.
		const rendered = mergeRenderedMessages(
			[
				persisted("u1", null, "do the thing", "user"),
				persisted("a1", "t1", "Looking…"),
				persisted("a2", "t1", "Editing…"),
				persisted("a3", "t1", "Done."),
			],
			{},
			sessionId,
		);

		// Before the fix this was four separate messages; the turn's three
		// rounds must come back as one, in stream order.
		expect(rendered.map((m) => m.id)).toEqual(["u1", "a1"]);
		expect(rendered[1]?.parts).toEqual([
			{ type: "text", text: "Looking…" },
			{ type: "text", text: "Editing…" },
			{ type: "text", text: "Done." },
		]);
	});

	it("keeps two turns apart across a full reconcile", () => {
		const rendered = mergeRenderedMessages(
			[
				persisted("u1", null, "first", "user"),
				persisted("a1", "t1", "one"),
				persisted("a2", "t1", "two"),
				persisted("u2", null, "second", "user"),
				persisted("a3", "t2", "three"),
			],
			{},
			sessionId,
		);

		expect(rendered.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a3"]);
	});

	it("renders live content while the turn streams, then the same shape after", () => {
		// Mid-turn: one live entry already holds the whole turn's parts, so the
		// rendered list is one message — the shape the user sees streaming.
		const streaming = mergeRenderedMessages(
			[persisted("u1", null, "do the thing", "user")],
			{ live1: live("live1", "Looking… then Editing…") },
			sessionId,
		);
		expect(streaming.map((m) => m.id)).toEqual(["u1", "live1"]);

		// After the turn: the DB rows replace it, and must regroup to the same
		// single assistant message — this equivalence is the whole point.
		const settled = mergeRenderedMessages(
			[
				persisted("u1", null, "do the thing", "user"),
				persisted("a1", "t1", "Looking…"),
				persisted("a2", "t1", "Editing…"),
			],
			{},
			sessionId,
		);
		expect(settled).toHaveLength(streaming.length);
		expect(settled.map((m) => m.role)).toEqual(streaming.map((m) => m.role));
	});

	it("lets a live entry shadow the persisted row sharing its id, and drops empty live entries", () => {
		// Live is the fresher copy: at the terminal reconcile the flushed live
		// entries are still in place until `loadHistory()`'s authoritative rows
		// land, so the live copy must win the id collision — not flicker back
		// to a provisional row.
		const rendered = mergeRenderedMessages(
			[persisted("a1", "t1", "from db")],
			{
				a1: live("a1", "fresher live copy"),
				// Nothing streamed into it yet — not a blank bubble.
				empty: { id: "empty", role: "assistant", parts: [], startedAt: 1 },
			},
			sessionId,
		);

		expect(rendered.map((m) => m.id)).toEqual(["a1"]);
		expect(rendered[0]?.parts).toEqual([
			{ type: "text", text: "fresher live copy" },
		]);
	});

	it("does not fold a live entry into an adjacent persisted turn", () => {
		// A live entry is already one whole turn; grouping it with the persisted
		// row next to it would merge two turns into one message.
		const rendered = mergeRenderedMessages(
			[persisted("a1", "t1", "previous turn", "assistant", 10)],
			{ live1: live("live1", "this turn") },
			sessionId,
		);

		expect(rendered.map((m) => m.id)).toEqual(["a1", "live1"]);
	});
});
