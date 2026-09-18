import type { AgentStreamEvent, Message, QueuedMessage } from "@dilna/shared";
import { makeAttachment } from "@dilna/shared/testing";
import { describe, expect, it } from "vitest";
import {
	type ChatAction,
	type ChatState,
	chatReducer,
	initialChatState,
	type TurnActivity,
} from "./chat-reducer";

/**
 * The stream fold's own tests (issue #237). No jsdom, no React, no mocked API:
 * feed a sequence of actions and assert the state. These are the cases that
 * used to require mounting the whole component and rendering *past* its
 * interface — the terminal flush-then-reconcile, the `user_message` sender race,
 * `message_start` idempotence — plus the ones whose table-driven shape only
 * became expressible once the transitions were one pure function.
 */

const SESSION = "sess-1";
const AT = () => 1_700_000_000;

function state(overrides: Partial<ChatState> = {}): ChatState {
	return { ...initialChatState(SESSION, "idle"), ...overrides };
}

function message(id: string, overrides: Partial<Message> = {}): Message {
	return {
		id,
		sessionId: SESSION,
		role: "user",
		parts: [{ type: "text", text: id }],
		createdAt: 1_600_000_000,
		turnId: null,
		...overrides,
	};
}

function queued(id: string): QueuedMessage {
	return {
		id,
		sessionId: SESSION,
		text: id,
		attachments: [],
		createdAt: 1_600_000_000,
	};
}

function activity(): TurnActivity {
	return {
		type: "turn_activity",
		phase: null,
		runningTools: [],
		tasks: [],
		serverTime: 1_700_000_000,
	};
}

/** Fold a whole action sequence, threading the injectable clock so a
 * `message_start` stamp is deterministic. */
function run(actions: ChatAction[], from: ChatState = state()): ChatState {
	return actions.reduce((s, a) => chatReducer(s, a, AT), from);
}

describe("initialChatState", () => {
	it("starts empty, seeded only by the Session prop's status", () => {
		const s = initialChatState(SESSION, "working");
		expect(s.status).toBe("working");
		expect(s.messages).toEqual([]);
		expect(s.live).toEqual({});
		expect(s.queued).toEqual([]);
		expect(s.sawTurn).toBe(false);
		expect(s.reconcile).toBe(0);
	});
});

describe("session_status", () => {
	it("marks a turn seen and thinks while working or starting", () => {
		for (const status of ["working", "starting"] as const) {
			const s = run([{ type: "session_status", status }]);
			expect(s.status).toBe(status);
			expect(s.sawTurn).toBe(true);
			expect(s.thinking).toBe(true);
		}
	});

	it("leaves thinking alone on a non-terminal, non-working status", () => {
		const s = run([
			{ type: "session_status", status: "working" },
			{ type: "session_status", status: "stopping" },
		]);
		expect(s.status).toBe("stopping");
		expect(s.thinking).toBe(true);
		expect(s.sawTurn).toBe(true);
	});

	describe("on a terminal status (idle/crashed)", () => {
		it("clears the in-turn snapshot: thinking, turn activity, thinking buffers", () => {
			const s = run([
				{ type: "session_status", status: "working" },
				activity(),
				{ type: "thinking", messageId: "m1", chunk: "hmm" },
				{ type: "session_status", status: "idle" },
			]);
			expect(s.thinking).toBe(false);
			expect(s.turnActivity).toBeNull();
			expect(s.thinkingBuffers).toEqual({});
		});

		it("flushes live entries into messages as ungrouped rows", () => {
			const s = run([
				{ type: "message_start", messageId: "m1", role: "assistant" },
				{ type: "token", messageId: "m1", chunk: "hello" },
				{ type: "session_status", status: "idle" },
			]);
			expect(s.live).toEqual({});
			expect(s.messages).toHaveLength(1);
			const flushed = s.messages[0];
			if (!flushed) throw new Error("expected a flushed message");
			expect(flushed.id).toBe("m1");
			expect(flushed.sessionId).toBe(SESSION);
			expect(flushed.role).toBe("assistant");
			expect(flushed.turnId).toBeNull();
			expect(flushed.parts).toEqual([{ type: "text", text: "hello" }]);
		});

		it("replaces an already-persisted row that a live entry shadowed", () => {
			// The same id can be in both lists while a turn is mid-flush; the
			// flushed copy is the fresher one, and it must not appear twice.
			const s = run(
				[
					{ type: "message_start", messageId: "m1", role: "assistant" },
					{ type: "token", messageId: "m1", chunk: "fresh" },
					{ type: "session_status", status: "idle" },
				],
				state({ messages: [message("m1", { parts: [] })] }),
			);
			expect(s.messages).toHaveLength(1);
			expect(s.messages[0]?.parts).toEqual([{ type: "text", text: "fresh" }]);
		});

		it("leaves messages and live identity untouched when there is nothing to flush", () => {
			const before = state({ messages: [message("m1")] });
			const after = chatReducer(
				before,
				{ type: "session_status", status: "idle" },
				AT,
			);
			expect(after.messages).toBe(before.messages);
			expect(after.live).toBe(before.live);
		});

		it("asks for a reconcile only when a turn was actually seen", () => {
			const unseen = run([{ type: "session_status", status: "idle" }]);
			expect(unseen.reconcile).toBe(0);
			expect(unseen.sawTurn).toBe(false);

			const seen = run([
				{ type: "session_status", status: "working" },
				{ type: "session_status", status: "idle" },
			]);
			expect(seen.reconcile).toBe(1);
			// The flag is consumed with the request, so the next idle snapshot
			// (a fresh subscribe) doesn't refetch a second time.
			expect(seen.sawTurn).toBe(false);
		});

		it("counts consecutive reconciles rather than collapsing them", () => {
			const one = run([
				{ type: "session_status", status: "working" },
				{ type: "session_status", status: "idle" },
				{ type: "session_status", status: "working" },
				{ type: "token", messageId: "m1", chunk: "x" },
				{ type: "session_status", status: "crashed" },
			]);
			expect(one.reconcile).toBe(2);
		});

		it("treats an idle snapshot before any activity as no turn at all", () => {
			// What a subscriber sees on open when the Session is already idle:
			// the server replays `idle`, and refetching history for it would be a
			// wasted round trip on every page load.
			const s = run([
				{ type: "reset" },
				{ type: "session_status", status: "idle" },
			]);
			expect(s.reconcile).toBe(0);
		});
	});
});

describe("user_message", () => {
	it("adds a live entry when the id is new, and marks the turn seen", () => {
		const s = run([{ type: "user_message", message: message("u1") }]);
		expect(s.sawTurn).toBe(true);
		expect(s.live.u1).toEqual({
			id: "u1",
			role: "user",
			parts: [{ type: "text", text: "u1" }],
			startedAt: 1_600_000_000,
		});
	});

	it("is a no-op for an id the sender's own tab already swapped in", () => {
		// handleSend's response swaps the temp id for this real one before the
		// broadcast arrives; the entry must not be clobbered (nor the state
		// reference churned).
		const before = run([
			{
				type: "send_accepted",
				tempId: "temp-1",
				message: message("u1", { parts: [{ type: "text", text: "mine" }] }),
			},
		]);
		const after = chatReducer(before, {
			type: "user_message",
			message: message("u1", { parts: [{ type: "text", text: "server" }] }),
		});
		expect(after.live.u1?.parts).toEqual([{ type: "text", text: "mine" }]);
	});
});

describe("message_start", () => {
	it("creates an empty assistant entry at the injected clock", () => {
		const s = run([
			{ type: "message_start", messageId: "m1", role: "assistant" },
		]);
		expect(s.live.m1).toEqual({
			id: "m1",
			role: "assistant",
			parts: [],
			startedAt: AT(),
		});
	});

	it("is idempotent — a repeated start keeps the original entry and startedAt", () => {
		const s = run(
			[
				{ type: "message_start", messageId: "m1", role: "assistant" },
				{ type: "token", messageId: "m1", chunk: "hi" },
			],
			state(),
		);
		const again = chatReducer(
			s,
			{ type: "message_start", messageId: "m1", role: "assistant" },
			() => 1_999_999_999,
		);
		expect(again.live.m1).toBe(s.live.m1);
	});

	/**
	 * The mid-turn replay (ADR-0014, issue #244). `SessionManager.subscribe`
	 * pushes `liveTurnReplayEvents` to any subscriber that connects while a turn
	 * is in flight, and a tab that is *reconnecting* already holds the message
	 * those events describe. The replay's `message_start` is marked, so the fold
	 * rebuilds that entry from empty; treating it as idempotent (the case above)
	 * leaves the tab to fold the whole re-narrated turn onto what it already has,
	 * repeating the prose and appending every tool call a second time.
	 */
	describe("a replay re-narrating a message this tab already holds", () => {
		/** What the tab has: it watched the turn stream so far. */
		const watched = () =>
			run([
				{ type: "message_start", messageId: "m1", role: "assistant" },
				{ type: "token", messageId: "m1", chunk: "Let me look. " },
				{
					type: "tool_call_start",
					messageId: "m1",
					callId: "c1",
					tool: "Bash",
					input: { command: "ls" },
				},
			]);

		/** The server's replay of that same turn, exactly as it goes on the wire. */
		const replay = (from: ChatState = watched()) =>
			run(
				[
					{
						type: "message_start",
						messageId: "m1",
						role: "assistant",
						replay: true,
					},
					{ type: "token", messageId: "m1", chunk: "Let me look. " },
					{
						type: "tool_call_start",
						messageId: "m1",
						callId: "c1",
						tool: "Bash",
						input: { command: "ls" },
					},
				],
				from,
			);

		it("rebuilds the message, so no part is doubled", () => {
			const after = replay();

			expect(after.live.m1?.parts).toEqual([
				{ type: "text", text: "Let me look. " },
				{
					type: "tool_call",
					callId: "c1",
					tool: "Bash",
					input: { command: "ls" },
					output: null,
				},
			]);
		});

		it("converges on what a tab that missed the turn builds from the replay alone", () => {
			const fromEmpty = replay(state());
			const overExisting = replay(watched());

			expect(overExisting.live.m1?.parts).toEqual(fromEmpty.live.m1?.parts);
		});

		it("keeps the entry's original startedAt", () => {
			const before = watched().live.m1?.startedAt;
			expect(replay().live.m1?.startedAt).toBe(before);
		});
	});
});

describe("content events", () => {
	const contentCases: [string, AgentStreamEvent][] = [
		["token", { type: "token", messageId: "m1", chunk: "hi" }],
		[
			"tool_call_start",
			{
				type: "tool_call_start",
				messageId: "m1",
				callId: "c1",
				tool: "Bash",
				input: {},
			},
		],
	];

	it.each(
		contentCases,
	)("clears thinking and marks the turn seen on %s", (_n, ev) => {
		const s = run([{ type: "session_status", status: "working" }, ev]);
		expect(s.thinking).toBe(false);
		expect(s.sawTurn).toBe(true);
	});

	it("keeps thinking on tool_call_end — it resolves a call the start already cleared", () => {
		const s = run([
			{ type: "session_status", status: "working" },
			{
				type: "tool_call_start",
				messageId: "m1",
				callId: "c1",
				tool: "Bash",
				input: {},
			},
			{ type: "tool_call_end", messageId: "m1", callId: "c1", output: "ok" },
		]);
		expect(s.thinking).toBe(false);
		expect(
			(
				s.live.m1?.parts[0] as
					| { type: "tool_call"; output?: unknown }
					| undefined
			)?.output,
		).toBe("ok");
	});

	it("folds image_sent into the addressed message's parts (ADR-0038)", () => {
		// The case that was silently missing before #222: the event was delivered
		// and dropped. Here it must land positionally among the prose.
		const s = run([
			{ type: "message_start", messageId: "m1", role: "assistant" },
			{ type: "token", messageId: "m1", chunk: "before" },
			{
				type: "image_sent",
				messageId: "m1",
				attachment: makeAttachment({ id: "a1" }),
			},
			{ type: "token", messageId: "m1", chunk: "after" },
		]);
		const parts = s.live.m1?.parts ?? [];
		expect(parts.map((p) => p.type)).toEqual(["text", "attachment", "text"]);
	});
});

describe("thinking buffers", () => {
	it("accumulates chunks per message", () => {
		const s = run([
			{ type: "thinking", messageId: "m1", chunk: "a" },
			{ type: "thinking", messageId: "m2", chunk: "x" },
			{ type: "thinking", messageId: "m1", chunk: "b" },
		]);
		expect(s.thinkingBuffers).toEqual({ m1: "ab", m2: "x" });
	});

	it("discards one message's buffer at its message_end, keeping the others", () => {
		const s = run([
			{ type: "thinking", messageId: "m1", chunk: "a" },
			{ type: "thinking", messageId: "m2", chunk: "x" },
			{ type: "message_end", messageId: "m1" },
		]);
		expect(s.thinkingBuffers).toEqual({ m2: "x" });
	});

	it("is a no-op at message_end for a message with no buffer", () => {
		const before = state();
		const after = chatReducer(
			before,
			{ type: "message_end", messageId: "m1" },
			AT,
		);
		expect(after).toBe(before);
	});
});

describe("turn_failed", () => {
	it("stops thinking and surfaces the message as the error line", () => {
		const s = run([
			{ type: "session_status", status: "working" },
			{ type: "turn_failed", class: "turn_error", message: "boom" },
		]);
		expect(s.thinking).toBe(false);
		expect(s.error).toBe("boom");
	});
});

describe("level-based snapshots", () => {
	it("replaces the queue wholesale on queue_update", () => {
		const s = run([
			{ type: "queue_update", queued: [queued("q1")] },
			{ type: "queue_update", queued: [queued("q2")] },
		]);
		expect(s.queued.map((q) => q.id)).toEqual(["q2"]);
	});

	it("replaces turn activity wholesale on turn_activity", () => {
		const s = run([activity()]);
		expect(s.turnActivity).toEqual(activity());
	});

	it("sets the transient notice line", () => {
		expect(run([{ type: "notice", message: "heads up" }]).notice).toBe(
			"heads up",
		);
	});
});

describe("reset (the ADR-0016 §4 directive)", () => {
	it("drops live-turn state but keeps messages until the refetch lands", () => {
		const s = run([
			{ type: "message_start", messageId: "m1", role: "assistant" },
			{ type: "token", messageId: "m1", chunk: "x" },
			activity(),
			{ type: "thinking", messageId: "m1", chunk: "think" },
			{ type: "session_status", status: "working" },
			{ type: "reset" },
		]);
		expect(s.live).toEqual({});
		expect(s.turnActivity).toBeNull();
		expect(s.thinkingBuffers).toEqual({});
		expect(s.sawTurn).toBe(false);
		// `messages`, `thinking`, `error` and `notice` are NOT the reset's job —
		// `history_loaded` and the reopened snapshot own them.
		expect(s.messages).toEqual([]);
	});

	it("behaves identically whether a resync event or a local reset arrives", () => {
		const seeded = state({
			live: {
				m1: {
					id: "m1",
					role: "assistant",
					parts: [],
					startedAt: 1,
				},
			},
			sawTurn: true,
		});
		const viaEvent = chatReducer(seeded, { type: "resync" }, AT);
		const viaDirective = chatReducer(seeded, { type: "reset" }, AT);
		expect(viaEvent).toEqual(viaDirective);
	});
});

describe("session_changed", () => {
	it("clears everything a new conversation must not inherit", () => {
		const s = run(
			[{ type: "session_changed", sessionId: "sess-2" }],
			state({
				messages: [message("m1")],
				queued: [queued("q1")],
				error: "old error",
				notice: "old notice",
				thinking: true,
				degraded: true,
				sawTurn: true,
			}),
		);
		expect(s.sessionId).toBe("sess-2");
		expect(s.messages).toEqual([]);
		expect(s.queued).toEqual([]);
		expect(s.error).toBeNull();
		expect(s.notice).toBeNull();
		expect(s.thinking).toBe(false);
		expect(s.degraded).toBe(false);
		expect(s.sawTurn).toBe(false);
	});
});

describe("history_loaded", () => {
	it("replaces messages and prunes live entries the DB now owns", () => {
		const s = run(
			[{ type: "history_loaded", messages: [message("m1")] }],
			state({
				live: {
					m1: { id: "m1", role: "assistant", parts: [], startedAt: 1 },
					"temp-1": { id: "temp-1", role: "user", parts: [], startedAt: 1 },
				},
			}),
		);
		expect(s.messages.map((m) => m.id)).toEqual(["m1"]);
		// The optimistic temp entry survives — it is not in the DB yet.
		expect(Object.keys(s.live)).toEqual(["temp-1"]);
	});

	it("keeps the live map's identity when nothing needed pruning", () => {
		const before = state({
			live: {
				"temp-1": { id: "temp-1", role: "user", parts: [], startedAt: 1 },
			},
		});
		const after = chatReducer(
			before,
			{ type: "history_loaded", messages: [message("m1")] },
			AT,
		);
		expect(after.live).toBe(before.live);
	});
});

describe("the send flow", () => {
	it("opens optimistically, then swaps the temp id for the persisted one", () => {
		const optimistic = {
			id: "temp-1",
			role: "user" as const,
			parts: [{ type: "text" as const, text: "hi" }],
			startedAt: AT(),
		};
		const started = run([{ type: "send_started", message: optimistic }]);
		expect(started.thinking).toBe(true);
		expect(started.error).toBeNull();
		expect(started.live["temp-1"]).toEqual(optimistic);

		const accepted = chatReducer(
			started,
			{ type: "send_accepted", tempId: "temp-1", message: message("u1") },
			AT,
		);
		expect(accepted.live["temp-1"]).toBeUndefined();
		expect(accepted.live.u1?.role).toBe("user");
	});

	it("withdraws the optimistic entry and stops thinking on failure", () => {
		const s = run([
			{
				type: "send_started",
				message: { id: "temp-1", role: "user", parts: [], startedAt: AT() },
			},
			{ type: "send_failed", tempId: "temp-1", message: "send failed" },
		]);
		expect(s.live["temp-1"]).toBeUndefined();
		expect(s.thinking).toBe(false);
		expect(s.error).toBe("send failed");
	});

	it("renders a lost send race (409) as a quiet notice, not an error", () => {
		const s = run([
			{
				type: "send_started",
				message: { id: "temp-1", role: "user", parts: [], startedAt: AT() },
			},
			{ type: "send_conflict", tempId: "temp-1" },
		]);
		expect(s.live["temp-1"]).toBeUndefined();
		expect(s.thinking).toBe(false);
		expect(s.error).toBeNull();
		expect(s.notice).toMatch(/Another tab/);
	});

	it("tolerates withdrawing an entry a resync already cleared", () => {
		const before = state();
		const after = chatReducer(
			before,
			{ type: "send_failed", tempId: "temp-1", message: "x" },
			AT,
		);
		expect(after.live).toBe(before.live);
	});
});

describe("queue tray edits", () => {
	it("appends an accepted entry optimistically, idempotently", () => {
		const once = run([{ type: "queued_added", entry: queued("q1") }]);
		expect(once.queued.map((q) => q.id)).toEqual(["q1"]);
		const twice = chatReducer(
			once,
			{ type: "queued_added", entry: queued("q1") },
			AT,
		);
		expect(twice).toBe(once);
	});

	it("removes an entry, and is a no-op for one already gone", () => {
		const before = run([{ type: "queued_added", entry: queued("q1") }]);
		const removed = chatReducer(
			before,
			{ type: "queued_removed", queuedId: "q1" },
			AT,
		);
		expect(removed.queued).toEqual([]);
		expect(
			chatReducer(removed, { type: "queued_removed", queuedId: "q1" }, AT),
		).toBe(removed);
	});
});

describe("identity preservation", () => {
	it("returns the same state for a no-op action, so React can bail out", () => {
		const before = state();
		const withNotice = chatReducer(
			before,
			{ type: "notice", message: "n" },
			AT,
		);
		expect(withNotice).not.toBe(before);
		expect(chatReducer(withNotice, { type: "notice", message: "n" }, AT)).toBe(
			withNotice,
		);
		expect(chatReducer(before, { type: "changed_files", files: [] }, AT)).toBe(
			before,
		);
		expect(
			chatReducer(before, { type: "status_synced", status: before.status }, AT),
		).toBe(before);
		expect(chatReducer(before, { type: "degraded", value: false }, AT)).toBe(
			before,
		);
	});
});
