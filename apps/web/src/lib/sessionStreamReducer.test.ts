import type {
	AgentStreamEvent,
	Message as ChatMessage,
	QueuedMessage,
	SessionView,
} from "@dilna/shared";
import { describe, expect, it } from "vitest";
import {
	initialSessionStreamState,
	type SessionStreamAction,
	type SessionStreamEffect,
	type SessionStreamState,
	sessionStreamReducer,
} from "./sessionStreamReducer";

const SESSION = "s1";

const start = () => initialSessionStreamState(SESSION, "idle");

/** Fold a list of actions, collecting every effect asked for along the way —
 * the shape almost every assertion below wants. */
function run(
	actions: SessionStreamAction[],
	from: SessionStreamState = start(),
): { state: SessionStreamState; effects: SessionStreamEffect[] } {
	let state = from;
	const effects: SessionStreamEffect[] = [];
	for (const action of actions) {
		const result = sessionStreamReducer(state, action);
		state = result.state;
		effects.push(...result.effects);
	}
	return { state, effects };
}

const ev = (event: AgentStreamEvent): SessionStreamAction => ({
	type: "event",
	event,
});

const status = (s: SessionView["status"]) =>
	ev({ type: "session_status", status: s });

const token = (messageId: string, chunk: string) =>
	ev({ type: "token", messageId, chunk });

const turnActivity = () =>
	ev({
		type: "turn_activity",
		phase: { kind: "requesting" },
		runningTools: [],
		tasks: [],
		serverTime: 1,
	});

const message = (id: string, text: string): ChatMessage => ({
	id,
	sessionId: SESSION,
	role: "user",
	parts: [{ type: "text", text }],
	turnId: null,
	createdAt: 1,
});

const queuedMessage = (id: string): QueuedMessage => ({
	id,
	sessionId: SESSION,
	text: id,
	attachments: [],
	createdAt: 1,
});

describe("sessionStreamReducer", () => {
	it("starts clean, carrying the session's current status", () => {
		const state = initialSessionStreamState(SESSION, "working");
		expect(state.status).toBe("working");
		expect(state.messages).toEqual([]);
		expect(state.live).toEqual({});
		expect(state.sawTurn).toBe(false);
	});

	describe("a turn", () => {
		it("marks thinking on the way into a turn", () => {
			const { state } = run([status("working")]);
			expect(state.thinking).toBe(true);
			expect(state.sawTurn).toBe(true);
		});

		it("stops thinking once content streams", () => {
			const { state } = run([
				status("working"),
				ev({ type: "message_start", messageId: "m1", role: "assistant" }),
				token("m1", "hi"),
			]);
			expect(state.thinking).toBe(false);
		});

		it("folds tokens into the live message", () => {
			const { state } = run([
				status("working"),
				ev({ type: "message_start", messageId: "m1", role: "assistant" }),
				token("m1", "hello "),
				token("m1", "world"),
			]);
			expect(state.live.m1?.parts).toEqual([
				{ type: "text", text: "hello world" },
			]);
		});

		// tool_call_end resolves a call whose _start already cleared the marker,
		// and can arrive while the next round is already thinking again.
		it("leaves thinking alone on tool_call_end", () => {
			const after = run([
				status("working"),
				ev({ type: "message_start", messageId: "m1", role: "assistant" }),
				token("m1", "x"),
			]);
			const thinkingAgain = run([status("working")], after.state);
			const { state } = run(
				[
					ev({
						type: "tool_call_end",
						messageId: "m1",
						callId: "t1",
						output: "ok",
					}),
				],
				thinkingAgain.state,
			);
			expect(state.thinking).toBe(true);
		});

		it("ignores a duplicate message_start", () => {
			const first = run([
				ev({ type: "message_start", messageId: "m1", role: "assistant" }),
				token("m1", "kept"),
			]);
			const { state } = run(
				[ev({ type: "message_start", messageId: "m1", role: "assistant" })],
				first.state,
			);
			expect(state.live.m1?.parts).toEqual([{ type: "text", text: "kept" }]);
		});

		it("converges on the broadcast id for a user message", () => {
			const { state } = run([
				ev({ type: "user_message", message: message("u1", "hi") }),
			]);
			expect(state.live.u1?.role).toBe("user");
			expect(state.sawTurn).toBe(true);
		});

		it("does not duplicate a user_message the sender already rendered", () => {
			const sent = run([{ type: "send", message: message("u1", "hi") }]);
			const { state } = run(
				[ev({ type: "user_message", message: message("u1", "hi") })],
				sent.state,
			);
			expect(Object.keys(state.live)).toEqual(["u1"]);
		});
	});

	// ADR-0016 §5: turn_activity and thinking are valid only inside a turn.
	// Previously enforced by remembering to clear two fields in two places.
	describe("ADR-0016 §5 — in-turn state is cleared at a terminal", () => {
		for (const terminal of ["idle", "crashed"] as const) {
			it(`clears activity and thinking buffers on ${terminal}`, () => {
				const { state } = run([
					status("working"),
					ev({ type: "message_start", messageId: "m1", role: "assistant" }),
					ev({ type: "thinking", messageId: "m1", chunk: "hmm" }),
					turnActivity(),
					status(terminal),
				]);
				expect(state.turnActivity).toBeNull();
				expect(state.thinkingBuffers).toEqual({});
				expect(state.thinking).toBe(false);
			});
		}

		it("discards a message's thinking buffer at its message_end", () => {
			const { state } = run([
				ev({ type: "message_start", messageId: "m1", role: "assistant" }),
				ev({ type: "thinking", messageId: "m1", chunk: "hmm" }),
				ev({ type: "message_end", messageId: "m1" }),
			]);
			expect(state.thinkingBuffers).toEqual({});
		});

		it("keeps other messages' thinking buffers at a message_end", () => {
			const { state } = run([
				ev({ type: "thinking", messageId: "m1", chunk: "a" }),
				ev({ type: "thinking", messageId: "m2", chunk: "b" }),
				ev({ type: "message_end", messageId: "m1" }),
			]);
			expect(state.thinkingBuffers).toEqual({ m2: "b" });
		});
	});

	describe("terminal reconcile", () => {
		it("flushes live entries into messages and refetches history", () => {
			const { state, effects } = run([
				status("working"),
				ev({ type: "message_start", messageId: "m1", role: "assistant" }),
				token("m1", "done"),
				status("idle"),
			]);
			expect(state.live).toEqual({});
			expect(state.messages).toHaveLength(1);
			expect(state.messages[0]?.id).toBe("m1");
			// The flushed row must carry the Session, which on a first turn is
			// not derivable from any existing row.
			expect(state.messages[0]?.sessionId).toBe(SESSION);
			expect(state.messages[0]?.turnId).toBeNull();
			expect(effects).toContain("load-history");
		});

		// The subscribe-time opening snapshot replays the current status; an
		// idle one must not trigger a refetch on every (re)connect.
		it("does not refetch on an idle snapshot with no turn seen", () => {
			const { effects } = run([status("idle")]);
			expect(effects).not.toContain("load-history");
		});

		it("refetches only once per turn", () => {
			const { effects } = run([
				status("working"),
				token("m1", "x"),
				status("idle"),
				status("idle"),
			]);
			expect(effects.filter((e) => e === "load-history")).toHaveLength(1);
		});

		it("treats a mid-turn join with no status as a turn", () => {
			// All a tab joining mid-turn sees is content.
			const { effects } = run([token("m1", "x"), status("idle")]);
			expect(effects).toContain("load-history");
		});
	});

	describe("resync (ADR-0016 §4)", () => {
		it("clears live-turn state but keeps persisted messages", () => {
			const loaded = run([
				{ type: "history-loaded", messages: [message("p1", "persisted")] },
				status("working"),
				ev({ type: "message_start", messageId: "m1", role: "assistant" }),
				ev({ type: "thinking", messageId: "m1", chunk: "hmm" }),
				turnActivity(),
			]);

			const { state, effects } = run([ev({ type: "resync" })], loaded.state);

			expect(state.messages.map((m) => m.id)).toEqual(["p1"]);
			expect(state.live).toEqual({});
			expect(state.turnActivity).toBeNull();
			expect(state.thinkingBuffers).toEqual({});
			expect(effects).toEqual(["load-history", "load-queue"]);
		});

		it("is the same whether the directive or the connection triggers it", () => {
			const base = run([status("working"), token("m1", "x")]).state;
			const viaEvent = sessionStreamReducer(base, ev({ type: "resync" }));
			const viaConnection = sessionStreamReducer(base, { type: "resync" });
			expect(viaEvent).toEqual(viaConnection);
		});

		it("does not refetch history for a turn it just forgot", () => {
			const resynced = run([status("working"), { type: "resync" }]);
			const { effects } = run([status("idle")], resynced.state);
			expect(effects).not.toContain("load-history");
		});
	});

	describe("history", () => {
		it("drops live entries the persisted rows supersede", () => {
			const live = run([
				ev({ type: "message_start", messageId: "m1", role: "assistant" }),
				token("m1", "a"),
				ev({ type: "message_start", messageId: "m2", role: "assistant" }),
				token("m2", "b"),
			]);
			const { state } = run(
				[{ type: "history-loaded", messages: [message("m1", "a")] }],
				live.state,
			);
			expect(Object.keys(state.live)).toEqual(["m2"]);
		});

		it("surfaces a load failure as an error", () => {
			const { state } = run([
				{ type: "history-failed", message: "failed to load messages" },
			]);
			expect(state.error).toBe("failed to load messages");
		});
	});

	describe("queue (ADR-0033)", () => {
		it("replaces the queue wholesale on queue_update", () => {
			const { state } = run([
				{ type: "queue-loaded", queued: [queuedMessage("q1")] },
				ev({ type: "queue_update", queued: [queuedMessage("q2")] }),
			]);
			expect(state.queued.map((q) => q.id)).toEqual(["q2"]);
		});
	});

	describe("failure and notices", () => {
		it("records turn_failed without assuming a terminal status", () => {
			const { state } = run([status("working"), token("m1", "x")]);
			const after = sessionStreamReducer(
				state,
				ev({ type: "turn_failed", class: "turn_error", message: "boom" }),
			);
			expect(after.state.error).toBe("boom");
			expect(after.state.thinking).toBe(false);
			// The terminal arrives separately (ADR-0016 §2).
			expect(after.state.status).toBe("working");
		});

		it("keeps a notice separate from an error", () => {
			const { state } = run([ev({ type: "notice", message: "degraded" })]);
			expect(state.notice).toBe("degraded");
			expect(state.error).toBeNull();
		});
	});

	describe("events owned by other consumers", () => {
		// ContextPanel and the usage hooks own these; this fold must not
		// duplicate their state, and must not choke on them either.
		const foreign: AgentStreamEvent[] = [
			{ type: "changed_files", files: [] },
			{
				type: "usage_update",
				messageId: "m1",
				usage: { inputTokens: 1, outputTokens: 1 },
			},
			{
				type: "context_usage",
				tokens: 1,
				contextWindow: 2,
				reserveTokens: 0,
			},
		];

		for (const event of foreign) {
			it(`ignores ${event.type}`, () => {
				const before = run([status("working"), token("m1", "x")]).state;
				const after = sessionStreamReducer(before, ev(event));
				expect(after.state).toBe(before);
				expect(after.effects).toEqual([]);
			});
		}
	});

	describe("reset", () => {
		it("clears everything on a session switch", () => {
			const dirty = run([
				{ type: "history-loaded", messages: [message("p1", "x")] },
				status("working"),
				token("m1", "y"),
			]);
			const { state } = run(
				[{ type: "reset", sessionId: "s2", status: "idle" }],
				dirty.state,
			);
			expect(state).toEqual(initialSessionStreamState("s2", "idle"));
		});
	});

	it("never mutates the state it is given", () => {
		const before = start();
		const snapshot = structuredClone(before);
		run(
			[
				status("working"),
				ev({ type: "message_start", messageId: "m1", role: "assistant" }),
				token("m1", "x"),
				status("idle"),
			],
			before,
		);
		expect(before).toEqual(snapshot);
	});
});
