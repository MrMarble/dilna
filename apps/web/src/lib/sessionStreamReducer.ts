import type {
	AgentStreamEvent,
	Message as ChatMessage,
	MessagePart,
	QueuedMessage,
	SessionView,
} from "@dilna/shared";
import {
	applyEventToLive,
	type LiveMessage,
	nowSeconds,
} from "./live-messages";

/** In-turn feedback snapshot (ADR-0016 §5) — the `turn_activity` event minus
 * its discriminant. */
export type TurnActivity = Extract<AgentStreamEvent, { type: "turn_activity" }>;

/**
 * The Session-level state the live-message fold left behind.
 *
 * Everything here is driven by the SSE protocol, which is what makes it a
 * unit worth folding: ADR-0016 §5's rule that `turn_activity` and `thinking`
 * are valid only *inside* a turn is a relationship between three of these
 * fields, and used to be enforced by remembering to clear two of them in the
 * `session_status` branch and again on `resync`. UI-only state (textarea
 * height, drag depth, expanded toggles) deliberately stays in the component.
 */
export type SessionStreamState = {
	/** The Session these events belong to. Part of the state because the fold
	 * stamps it onto rows flushed out of `live` at a terminal — deriving it
	 * from an existing row would break on the first turn of an empty
	 * transcript. */
	sessionId: string;
	/** Authoritative persisted rows, from `GET /api/sessions/:id/messages`. */
	messages: ChatMessage[];
	/** In-flight turn messages, keyed by message id, folded from content
	 * events; flushed into `messages` at a terminal status. */
	live: Record<string, LiveMessage>;
	status: SessionView["status"];
	error: string | null;
	/** Transient degraded-not-failed line (ADR-0016 §2's `notice`) — separate
	 * from `error` so it renders as an unobtrusive line, not a destructive one. */
	notice: string | null;
	/** True from send → first assistant token/tool_call; suppresses the
	 * 'Thinking...' marker once content starts streaming. */
	thinking: boolean;
	/** Replaced wholesale on every `turn_activity`, cleared at any terminal. */
	turnActivity: TurnActivity | null;
	/** Per-message `thinking` chunk buffers — transient, mirrors `token`'s
	 * buffering but never persisted (ADR-0016 §5's invariant: `token` is
	 * exactly what persists, `thinking` is exactly what doesn't). */
	thinkingBuffers: Record<string, string>;
	/** The Session's server-held send queue (ADR-0033) — a mirror of the
	 * server's rows; the server owns enqueue, ordering and dispatch, this
	 * exists purely to render the tray. */
	queued: QueuedMessage[];
	/** True once turn activity (a status flip to working, or any mid-turn
	 * content event — all a tab joining mid-turn ever sees) has hit this
	 * subscription. Gates the terminal history reconcile so the subscribe-time
	 * idle snapshot doesn't refetch. Was a ref precisely because it is not
	 * rendered; it lives here now because it is protocol state, and the
	 * reducer is what reads and clears it. */
	sawTurn: boolean;
	/** Bumped whenever the fold asks for the matching refetch — see
	 * {@link EffectRequests}. */
	requests: EffectRequests;
};

/**
 * I/O the reducer *asks for* rather than performs.
 *
 * The fold has to stay pure to be worth extracting, but two protocol rules
 * are inherently effectful: a terminal status reconciles against the DB (the
 * source of truth, ADR-0004), and a `resync` directive refetches both history
 * and the queue. Returning them as data keeps the rules assertable — "an idle
 * terminal after a turn refetches history" is an assertion about a value, not
 * a mock expectation — and leaves the component as the only thing that
 * touches `api`.
 */
export type SessionStreamEffect = "load-history" | "load-queue";

export type SessionStreamResult = {
	state: SessionStreamState;
	effects: readonly SessionStreamEffect[];
};

/**
 * A request counter per effect, carried *in* the state.
 *
 * `useReducer` wants `(state, action) => state`, so a reducer that returned
 * effects on the side would need somewhere out-of-band to put them — and
 * anything out-of-band breaks under React's double-invoked reducers (an
 * effect would fire twice) and under two components sharing the module.
 *
 * Keeping the request in state sidesteps both: the reducer stays pure and
 * idempotent (double-invoking it yields the same counter, not two requests),
 * while the component drives its I/O off a `useEffect` keyed on the counter.
 * Tests still read the effects directly off `SessionStreamResult` and never
 * touch these.
 */
export type EffectRequests = Record<SessionStreamEffect, number>;

/** A terminal status ends a turn; both clear in-turn state (ADR-0016 §5). */
function isTerminal(status: SessionView["status"]): boolean {
	return status === "idle" || status === "crashed";
}

export function initialSessionStreamState(
	sessionId: string,
	status: SessionView["status"],
): SessionStreamState {
	return {
		sessionId,
		messages: [],
		live: {},
		status,
		error: null,
		notice: null,
		thinking: false,
		turnActivity: null,
		thinkingBuffers: {},
		queued: [],
		sawTurn: false,
		requests: { "load-history": 0, "load-queue": 0 },
	};
}

/**
 * Actions that are not stream events: the component's own local transitions
 * (a send, a resolved refetch) that touch the same correlated state.
 *
 * They belong in the same fold rather than alongside it as stray setters —
 * `send` has to set `thinking` and `sawTurn` together exactly as a
 * `session_status: working` does, and history landing has to drop the live
 * entries it superseded.
 */
export type SessionStreamAction =
	| { type: "event"; event: AgentStreamEvent }
	/** Session switch / stream (re)open: back to a clean slate. */
	| { type: "reset"; sessionId: string; status: SessionView["status"] }
	/** ADR-0016 §4's resync point: drop live-turn state, keep persisted rows,
	 * and refetch. Distinct from `reset`, which also clears history. */
	| { type: "resync" }
	/** `GET /messages` landed — authoritative rows replace the provisional
	 * copies they supersede. */
	| { type: "history-loaded"; messages: ChatMessage[] }
	| { type: "history-failed"; message: string }
	/** `GET /queued-messages` landed. */
	| { type: "queue-loaded"; queued: QueuedMessage[] }
	/** Local optimistic send, before the stream echoes it back. */
	| { type: "send"; message: ChatMessage }
	/** The send was accepted: swap the optimistic entry for the persisted row
	 * (ADR-0016 §6), so this tab converges on the same id every other
	 * subscriber gets via the `user_message` broadcast. */
	| { type: "send-accepted"; tempId: string; message: ChatMessage }
	/** The send never reached the server: withdraw the optimistic entry rather
	 * than leave a bubble the Agent never saw. `notice` vs `error` is the
	 * caller's call (a lost 409 race is not destructive). */
	| {
			type: "send-failed";
			tempId: string;
			error?: string;
			notice?: string;
	  }
	/** Optimistic enqueue; `queue_update` carries the same id, and level-based
	 * replacement makes the merge idempotent whichever lands first. */
	| { type: "queued"; entry: QueuedMessage }
	| { type: "queue-removed"; queuedId: string }
	| { type: "status-changed"; status: SessionView["status"] }
	| { type: "error"; message: string | null }
	| { type: "notice"; message: string | null };

const NO_EFFECTS: readonly SessionStreamEffect[] = [];

/** The one place a result is built, so bumping the in-state request counters
 * can't be forgotten in an individual branch. */
function result(
	state: SessionStreamState,
	effects: readonly SessionStreamEffect[] = NO_EFFECTS,
): SessionStreamResult {
	if (effects.length === 0) return { state, effects };
	const requests = { ...state.requests };
	for (const effect of effects) requests[effect] += 1;
	return { state: { ...state, requests }, effects };
}

/**
 * The one transition function for a Session's stream state (issue #203).
 *
 * Previously a ~180-line `switch` inside a `useEffect`, mutating six
 * correlated `useState`s through scattered setter calls — which meant the
 * protocol rules were reachable only by rendering the component and firing
 * fake SSE events through a mocked `@/api/client`. Follows the precedent of
 * `9c4695b` ("one live-turn fold for server and web"), which made the same
 * move for the *message* fold; this is that move applied to the session-level
 * state it left behind.
 */
export function sessionStreamReducer(
	state: SessionStreamState,
	action: SessionStreamAction,
): SessionStreamResult {
	switch (action.type) {
		case "reset":
			return result(initialSessionStreamState(action.sessionId, action.status));

		case "resync":
			// Persisted `messages` deliberately survive: they are authoritative
			// and the refetch below replaces them wholesale, so clearing here
			// would only blank the transcript for a beat.
			return result(
				{
					...state,
					live: {},
					turnActivity: null,
					thinkingBuffers: {},
					sawTurn: false,
				},
				["load-history", "load-queue"],
			);

		case "history-loaded": {
			// Drop live entries the persisted rows supersede; anything still
			// streaming stays.
			const persisted = new Set(action.messages.map((m) => m.id));
			const live: Record<string, LiveMessage> = {};
			for (const [id, m] of Object.entries(state.live)) {
				if (!persisted.has(id)) live[id] = m;
			}
			return result({ ...state, messages: action.messages, live });
		}

		case "history-failed":
			return result({ ...state, error: action.message });

		case "queue-loaded":
			return result({ ...state, queued: action.queued });

		case "send": {
			const sent = toLive(action.message);
			return result({
				...state,
				thinking: true,
				sawTurn: true,
				error: null,
				live: sent ? { ...state.live, [action.message.id]: sent } : state.live,
			});
		}

		case "send-accepted": {
			if (!(action.tempId in state.live)) {
				return result(state);
			}
			const accepted = toLive(action.message);
			const live = { ...state.live };
			delete live[action.tempId];
			if (accepted) live[action.message.id] = accepted;
			return result({ ...state, live });
		}

		case "send-failed": {
			const live = { ...state.live };
			delete live[action.tempId];
			return result({
				...state,
				live,
				thinking: false,
				...(action.error === undefined ? {} : { error: action.error }),
				...(action.notice === undefined ? {} : { notice: action.notice }),
			});
		}

		case "queued":
			return result({
				...state,
				queued: state.queued.some((q) => q.id === action.entry.id)
					? state.queued
					: [...state.queued, action.entry],
			});

		case "queue-removed":
			return result({
				...state,
				queued: state.queued.filter((q) => q.id !== action.queuedId),
			});

		case "status-changed":
			return result({ ...state, status: action.status });

		case "error":
			return result({ ...state, error: action.message });

		case "notice":
			return result({ ...state, notice: action.message });

		case "event":
			return applyEvent(state, action.event);
	}
}

/** A persisted row becoming a live entry, or `null` for a `system` row — a
 * role a live entry cannot hold, and which never streams as part of a turn.
 * Returning `null` rather than coercing keeps the narrowing honest: callers
 * leave such a row to the history refetch instead of inventing a bubble. */
function toLive(message: ChatMessage): LiveMessage | null {
	if (message.role === "system") return null;
	return {
		id: message.id,
		role: message.role,
		parts: message.parts,
		startedAt: message.createdAt,
	};
}

function applyEvent(
	state: SessionStreamState,
	event: AgentStreamEvent,
): SessionStreamResult {
	switch (event.type) {
		case "session_status": {
			if (event.status === "working" || event.status === "starting") {
				// Covers the mid-turn (re)connect: the server replays a working
				// status on subscribe, and until the snapshot or the next token
				// arrives the thinking marker is the only signal the agent is
				// alive.
				return result({
					...state,
					status: event.status,
					sawTurn: true,
					thinking: true,
				});
			}

			if (!isTerminal(event.status)) {
				return result({ ...state, status: event.status });
			}

			// Terminal. Flush live entries into the local list so nothing
			// flickers, then reconcile against the DB — the source of truth
			// (ADR-0004): the refetch replaces the flushed copies' provisional
			// ids/timestamps, and drops the optimistic temp user entry (whose
			// content the server persisted at send time).
			const liveIds = new Set(Object.keys(state.live));
			const flushed: ChatMessage[] = Object.values(state.live).map((m) => ({
				id: m.id,
				sessionId: state.sessionId,
				role: m.role,
				parts: m.parts,
				// Explicitly ungroupable: a live entry is already one whole turn's
				// worth of parts, and this is a stopgap for the refetch below,
				// which replaces it with the DB row carrying the real `turnId`.
				turnId: null,
				createdAt: m.startedAt,
			}));
			return result(
				{
					...state,
					status: event.status,
					thinking: false,
					// turn_activity/thinking are valid only inside a turn
					// (ADR-0016 §5) — cleared at any terminal rather than waiting
					// for an explicit clearing event.
					turnActivity: null,
					thinkingBuffers: {},
					live: {},
					messages:
						liveIds.size === 0
							? state.messages
							: [
									...state.messages.filter((m) => !liveIds.has(m.id)),
									...flushed,
								],
					sawTurn: false,
				},
				// Only reconcile if this subscription actually saw a turn — the
				// subscribe-time idle snapshot must not trigger a refetch.
				state.sawTurn ? ["load-history"] : NO_EFFECTS,
			);
		}

		case "user_message": {
			// Broadcast at accept time (ADR-0016 §6) — every subscriber converges
			// on this id. The sender's own tab may already have swapped its
			// optimistic bubble for this same id (a benign race either way
			// settles on the same entry).
			if (state.live[event.message.id]) {
				return result({ ...state, sawTurn: true });
			}
			const broadcast = toLive(event.message);
			return result({
				...state,
				sawTurn: true,
				live: broadcast
					? { ...state.live, [event.message.id]: broadcast }
					: state.live,
			});
		}

		case "message_start":
			// Always a new assistant turn message (pi.ts never emits user-role
			// starts); the optimistic temp user entry stays until the terminal
			// reconcile swaps in the DB rows.
			if (state.live[event.messageId]) {
				return result({ ...state, sawTurn: true });
			}
			return result({
				...state,
				sawTurn: true,
				live: {
					...state.live,
					[event.messageId]: {
						id: event.messageId,
						role: event.role,
						parts: [] as MessagePart[],
						startedAt: nowSeconds(),
					},
				},
			});

		case "token":
		case "tool_call_start":
		case "tool_call_end":
			// Content stops the 'Thinking...' marker — except tool_call_end,
			// which resolves a call whose _start already cleared it and can
			// arrive while the next round is thinking again.
			return result({
				...state,
				...(event.type === "tool_call_end"
					? {}
					: { thinking: false, sawTurn: true }),
				live: applyEventToLive(state.live, event),
			});

		case "thinking":
			return result({
				...state,
				thinkingBuffers: {
					...state.thinkingBuffers,
					[event.messageId]:
						(state.thinkingBuffers[event.messageId] ?? "") + event.chunk,
				},
			});

		case "message_end": {
			// Discard this message's thinking buffer — it never persists.
			if (!(event.messageId in state.thinkingBuffers)) {
				return result(state);
			}
			const thinkingBuffers = { ...state.thinkingBuffers };
			delete thinkingBuffers[event.messageId];
			return result({ ...state, thinkingBuffers });
		}

		case "turn_failed":
			// The one failure event (ADR-0016 §2): the terminal status itself
			// arrives as a separate session_status right after.
			return result({ ...state, thinking: false, error: event.message });

		case "queue_update":
			// Level-based snapshot (ADR-0033) — replace wholesale, exactly like
			// `changed_files`: every tab converges without diffing.
			return result({ ...state, queued: event.queued });

		case "notice":
			return result({ ...state, notice: event.message });

		case "turn_activity":
			return result({ ...state, turnActivity: event });

		case "resync":
			return sessionStreamReducer(state, { type: "resync" });

		// Owned by other consumers (ContextPanel, the usage hooks) — this fold
		// deliberately ignores them rather than duplicating their state.
		case "changed_files":
		case "artefact_published":
		case "usage_update":
		case "context_usage":
			return result(state);
	}
}
