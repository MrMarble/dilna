import type {
	AgentStreamEvent,
	Message,
	MessageContentEvent,
	QueuedMessage,
	SessionView,
} from "@dilna/shared";
import {
	applyEventToLive,
	type LiveMessage,
	nowSeconds,
} from "@/lib/live-messages";

/** The in-turn feedback snapshot (ADR-0016 §5) — level-based, valid only
 * inside a turn: cleared on any terminal status, never re-derived from it. */
export type TurnActivity = Extract<AgentStreamEvent, { type: "turn_activity" }>;

/**
 * Everything about a Session's chat that the event stream owns — the residue
 * of `ChatShell`'s former dozen independent `useState` setters, collected into
 * one value so the stream fold has an interface to be tested through (issue
 * #237).
 *
 * Nothing here is render-only: each field is either fed by the stream or
 * cleared by it, and the two are the same transition table. Local UI state
 * that the stream never touches — the composer draft, the sending flag, the
 * debounced `degraded` pill's *timer* — deliberately does not live here.
 *
 * `sessionId` is carried because a terminal status folds `live` entries into
 * `messages`, and a `Message` needs its `sessionId`. It is also what
 * `session_changed` compares against: the same immutable snapshot value is
 * returned when the id is unchanged, so a re-render cannot churn the fold.
 */
export type ChatState = {
	sessionId: string;
	/** Authoritative persisted rows (ADR-0004: the DB is the source of truth);
	 * `live` is the in-flight overlay merged over them at render time. */
	messages: Message[];
	/** In-flight messages keyed by id, as they stream in — the rendering
	 * optimization that never outlives the turn it belongs to. */
	live: Record<string, LiveMessage>;
	status: SessionView["status"];
	/** Mirror of the server-held send queue (ADR-0033) — seeded by the resync's
	 * REST GET, kept live by level-based `queue_update` broadcasts. */
	queued: QueuedMessage[];
	/** True from send → first assistant token/tool_call; suppresses the
	 * 'Thinking…' marker once content starts streaming. */
	thinking: boolean;
	/** In-turn feedback snapshot (ADR-0016 §5), replaced wholesale on every
	 * `turn_activity` and cleared on any terminal status. */
	turnActivity: TurnActivity | null;
	/** Per-message `thinking` chunk buffers — transient, mirrors `token`'s
	 * buffering but never persisted; cleared at that message's `message_end`. */
	thinkingBuffers: Record<string, string>;
	/** Destructive error line (turn failure, send/history failure). */
	error: string | null;
	/** Transient degraded-not-failed line (ADR-0016 §2's `notice`) — separate
	 * from `error` so it renders as an unobtrusive line, not a destructive one. */
	notice: string | null;
	/** True once turn activity (a status flip to working, or any mid-turn
	 * content event — which is all a tab joining mid-turn ever sees) has hit
	 * this subscription. Gates the idle-time history reconcile so the
	 * subscribe-time idle snapshot doesn't refetch. Was a `useRef` before this
	 * reducer existed: a ref was the only way a setState updater could *read*
	 * the flag the sibling setters needed, which is exactly the coupling this
	 * module removes. */
	sawTurn: boolean;
	/** Incremented when a terminal status ends a turn this tab actually saw, so
	 * an effect can refetch history. A counter rather than a boolean so two
	 * consecutive reconcilable terminals can't collapse into one — and read by
	 * the effect, never by rendering, because the fetch itself is an effect and
	 * cannot live in a pure fold. */
	reconcile: number;
	/** ~3s-debounced "Reconnecting…" pill (ADR-0016 §4) — nothing shows while
	 * healthy, and recovery clears it instantly. The debounce is the
	 * component's timer; the resulting value is state here so the component
	 * dispatches its connection outcome instead of setting it. */
	degraded: boolean;
};

/**
 * What the fold consumes. `AgentStreamEvent` is the bulk of it — the reducer
 * is the stream's consumer, and adding a variant to
 * `packages/shared/src/events.ts` must fail to compile here until it is
 * listed, exactly as it did when this switch lived in the component.
 *
 * The non-stream members are the transitions a setter used to perform that
 * aren't events on the wire: the resync directive's reset, the two REST
 * snapshots the on-open routine fetches, the send flow's optimistic
 * entry/swap/withdraw, and the local edits (queue tray, error clearing) the
 * component makes around its own async calls.
 */
export type ChatAction =
	| AgentStreamEvent
	/** The ADR-0016 §4 reset, dispatched by `resync` before its two fetches:
	 * drop live-turn state so the opened snapshot rebuilds it. `messages` is
	 * deliberately untouched — the follow-up `history_loaded` replaces it. */
	| { type: "reset" }
	/** The Session prop changed: this is a different conversation entirely, so
	 * even the fields `reset` keeps are cleared. */
	| { type: "session_changed"; sessionId: string }
	/** `loadHistory()` landed — authoritative rows, plus a prune of any live
	 * entry the DB now owns (its fresher copy has been superseded). */
	| { type: "history_loaded"; messages: Message[] }
	| { type: "queue_loaded"; queued: QueuedMessage[] }
	/** `session.status` prop sync (the sidebar/route can change it out from
	 * under a mounted chat). */
	| { type: "status_synced"; status: SessionView["status"] }
	/** A direct send is optimistic: the placeholder bubble shows immediately so
	 * autoscroll follows it, and `thinking` covers the gap until the first
	 * token. `message` is the not-yet-persisted entry, keyed by a temp id. */
	| { type: "send_started"; message: LiveMessage }
	/** The send's 202 landed: swap the temp-id bubble for the persisted row's
	 * real id — the same id every other subscriber sees via `user_message`
	 * (ADR-0016 §6), so all clients converge on one entry (a benign race
	 * either way settles identically). */
	| { type: "send_accepted"; tempId: string; message: Message }
	/** The send never reached the server: withdraw the optimistic entry rather
	 * than leaving a bubble the agent never saw. */
	| { type: "send_failed"; tempId: string; message: string }
	/** Lost the race to a concurrent send from another tab (ADR-0016 §6): the
	 * entry is withdrawn like any failed send, but the outcome is a quiet
	 * notice — this tab is already rendering the in-flight turn it lost to. */
	| { type: "send_conflict"; tempId: string }
	/** Optimistic append of a just-accepted queue entry (ADR-0033). Idempotent
	 * against the `queue_update` broadcast carrying the same id. */
	| { type: "queued_added"; entry: QueuedMessage }
	| { type: "queued_removed"; queuedId: string }
	/** Set or clear the destructive error line from the component's own async
	 * flows (stop, withdraw, history load, clearing before a send). */
	| { type: "error_set"; message: string | null }
	/** The component's debounced connection-loss timer resolving. */
	| { type: "degraded"; value: boolean };

/** The state a freshly mounted `ChatShell` starts from. The `session.status`
 * prop seeds `status`; everything else is empty until the opening snapshot
 * arrives. */
export function initialChatState(
	sessionId: string,
	status: SessionView["status"],
): ChatState {
	return {
		sessionId,
		messages: [],
		live: {},
		status,
		queued: [],
		thinking: false,
		turnActivity: null,
		thinkingBuffers: {},
		error: null,
		notice: null,
		sawTurn: false,
		reconcile: 0,
		degraded: false,
	};
}

/**
 * Fold one action into the chat state (issue #237).
 *
 * Pure but for the clock: `message_start` and a `token` for a message this tab
 * never saw start must stamp a `startedAt`, and that is the only non-determinism
 * in here. `now` is injectable for exactly the reason `applyEventToLive`'s is —
 * a test asserts on state, not on a wall clock — and `useReducer` calls the
 * reducer with two arguments, so the default applies in the app.
 *
 * The identity discipline the former setters kept is preserved: an action that
 * would not change a field returns the same reference, so React can bail out of
 * the re-render instead of re-rendering the whole transcript for a `notice` the
 * user has already seen.
 */
export function chatReducer(
	state: ChatState,
	action: ChatAction,
	now: () => number = nowSeconds,
): ChatState {
	switch (action.type) {
		case "session_status": {
			const next: ChatState = { ...state, status: action.status };
			if (action.status === "working" || action.status === "starting") {
				next.sawTurn = true;
				// Covers the mid-turn (re)connect: the server replays a working
				// status on subscribe, and until the snapshot or the next token
				// arrives the thinking marker is the only signal the agent is alive.
				next.thinking = true;
			}
			if (action.status === "idle" || action.status === "crashed") {
				next.thinking = false;
				// turn_activity/thinking are valid only inside a turn (ADR-0016 §5)
				// — clear the client's own copy at any terminal rather than waiting
				// for an explicit clearing event.
				next.turnActivity = null;
				next.thinkingBuffers = {};
				// Flush live entries into the local list so nothing flickers, then
				// reconcile against the DB — the source of truth (ADR-0004):
				// authoritative rows replace the flushed copies' provisional
				// ids/timestamps, and the optimistic temp user entry (whose content
				// the server persisted at send time) drops out.
				const flushed = flushLive(state);
				next.messages = flushed.messages;
				next.live = flushed.live;
				if (state.sawTurn) {
					next.sawTurn = false;
					// The fetch itself is an effect (see `reconcile`); the reducer
					// only records that one is owed.
					next.reconcile = state.reconcile + 1;
				}
			}
			return next;
		}
		case "user_message": {
			if (state.live[action.message.id]) {
				// Already known (the sender's own tab swapped its temp entry for
				// this id via `send_accepted`), but the turn is still under way.
				return state.sawTurn ? state : { ...state, sawTurn: true };
			}
			// Broadcast at accept time (ADR-0016 §6) — every subscriber converges
			// on this id. Non-sender tabs see this as the only signal the turn
			// started until the next content event.
			return {
				...state,
				sawTurn: true,
				live: {
					...state.live,
					[action.message.id]: {
						id: action.message.id,
						role: "user",
						parts: action.message.parts,
						startedAt: action.message.createdAt,
					},
				},
			};
		}
		case "message_start": {
			// Always a new assistant turn message (pi.ts never emits user-role
			// starts); the optimistic temp user entry stays in place until the
			// idle-time reconcile swaps in the DB rows. Idempotent: a message the
			// tab already knows keeps its entry (and its `startedAt`).
			const withSawTurn = state.sawTurn ? state : { ...state, sawTurn: true };
			if (withSawTurn.live[action.messageId]) return withSawTurn;
			return {
				...withSawTurn,
				live: {
					...withSawTurn.live,
					[action.messageId]: {
						id: action.messageId,
						role: action.role,
						parts: [],
						startedAt: now(),
					},
				},
			};
		}
		case "token":
		case "image_sent":
		case "tool_call_start":
		case "tool_call_end":
			return applyContent(state, action, now);
		case "message_end": {
			// Discard this message's thinking buffer — it never persists
			// (ADR-0016 §5's invariant: `token` is exactly what persists,
			// `thinking` is exactly what doesn't).
			if (!(action.messageId in state.thinkingBuffers)) return state;
			const thinkingBuffers = { ...state.thinkingBuffers };
			delete thinkingBuffers[action.messageId];
			return { ...state, thinkingBuffers };
		}
		case "turn_failed": {
			// The one failure event (ADR-0016 §2, replacing `error` +
			// `agent_crashed`): the terminal status itself (idle/crashed) arrives
			// as a separate session_status right after, handled above.
			return {
				...state,
				thinking: false,
				error: action.message,
			};
		}
		case "queue_update":
			// Level-based snapshot (ADR-0033) — replace wholesale, exactly like
			// `changed_files`: every tab converges on the server's queue without
			// diffing.
			return { ...state, queued: action.queued };
		case "notice":
			return state.notice === action.message
				? state
				: { ...state, notice: action.message };
		case "thinking":
			return {
				...state,
				thinkingBuffers: {
					...state.thinkingBuffers,
					[action.messageId]:
						(state.thinkingBuffers[action.messageId] ?? "") + action.chunk,
				},
			};
		case "turn_activity":
			return { ...state, turnActivity: action };
		case "resync":
		case "reset":
			return { ...state, ...resettable() };
		case "session_changed":
			return {
				...state,
				...resettable(),
				sessionId: action.sessionId,
				messages: [],
				queued: [],
				error: null,
				notice: null,
				thinking: false,
				degraded: false,
			};
		case "history_loaded": {
			const persistedIds = new Set(action.messages.map((m) => m.id));
			let nextLive = state.live;
			let changed = false;
			for (const id of Object.keys(state.live)) {
				if (persistedIds.has(id)) {
					changed = true;
					break;
				}
			}
			if (changed) {
				nextLive = {};
				for (const [id, m] of Object.entries(state.live)) {
					if (!persistedIds.has(id)) nextLive[id] = m;
				}
			}
			return { ...state, messages: action.messages, live: nextLive };
		}
		case "queue_loaded":
			return { ...state, queued: action.queued };
		case "status_synced":
			return action.status === state.status
				? state
				: { ...state, status: action.status };
		case "send_started":
			return {
				...state,
				error: null,
				thinking: true,
				live: { ...state.live, [action.message.id]: action.message },
			};
		case "send_accepted": {
			const next = { ...state.live };
			delete next[action.tempId];
			next[action.message.id] = {
				id: action.message.id,
				role: "user",
				parts: action.message.parts,
				startedAt: action.message.createdAt,
			};
			return { ...state, live: next };
		}
		case "send_failed":
			return {
				...withdrawLive(state, action.tempId),
				thinking: false,
				error: action.message,
			};
		case "send_conflict":
			return {
				...withdrawLive(state, action.tempId),
				thinking: false,
				// Keep the draft (the composer was never cleared) and show a quiet
				// notice, not a destructive error.
				notice: "Another tab just sent a message — your draft is still here.",
			};
		case "queued_added":
			return state.queued.some((q) => q.id === action.entry.id)
				? state
				: { ...state, queued: [...state.queued, action.entry] };
		case "queued_removed": {
			if (!state.queued.some((q) => q.id === action.queuedId)) return state;
			return {
				...state,
				queued: state.queued.filter((q) => q.id !== action.queuedId),
			};
		}
		case "error_set":
			return state.error === action.message
				? state
				: { ...state, error: action.message };
		case "degraded":
			return state.degraded === action.value
				? state
				: { ...state, degraded: action.value };
		// Handled by sibling subscribers on the same hub, not by the chat:
		// `ContextPanel` owns `changed_files`/`artefact_published`, and the
		// usage/context badges own `usage_update`/`context_usage`. Listing them
		// explicitly (rather than leaning on the `default:` below) is what makes
		// the exhaustiveness assert meaningful — a new variant must be placed
		// *somewhere*, even if that somewhere is a deliberate no-op.
		case "changed_files":
		case "artefact_published":
		case "usage_update":
		case "context_usage":
			return state;
		default: {
			// Exhaustiveness assert: every `AgentStreamEvent` variant must be
			// handled above — by a real case or by one of the deliberate no-ops.
			// Adding a variant in `packages/shared/src/events.ts` fails to compile
			// here until it is listed, which is exactly what caught `image_sent`
			// being silently dropped (issue #222).
			const _never: never = action;
			void _never;
			return state;
		}
	}
}

/** Content stops the 'Thinking…' marker — except `tool_call_end`, which
 * resolves a call whose _start already cleared it and can arrive while the next
 * round is thinking again. An `image_sent` is content: the Agent sent a picture
 * mid-turn and the live view has to show it now, not at the next refetch
 * (issue #222, ADR-0038). */
function applyContent(
	state: ChatState,
	ev: MessageContentEvent,
	now: () => number,
): ChatState {
	const next =
		ev.type === "tool_call_end"
			? state
			: { ...state, thinking: false, sawTurn: true };
	const live = applyEventToLive(next.live, ev, now);
	return live === next.live ? next : { ...next, live };
}

/** The ADR-0016 §4 reset: live-turn state is dropped so the opened snapshot
 * rebuilds it. `messages` is untouched — the reconcile that follows replaces
 * it. Shared by `reset` and `session_changed` so the two can't drift. */
function resettable(): Partial<ChatState> {
	return {
		live: {},
		turnActivity: null,
		thinkingBuffers: {},
		sawTurn: false,
	};
}

/** Fold every live entry into `messages` as one whole turn's worth of parts
 * and empty the live map — the stopgap the `history_loaded` right after it
 * replaces. Returns the inputs unchanged when there is nothing to flush, so the
 * common "terminal status with no live entries" case is a no-op. */
function flushLive(state: ChatState): Pick<ChatState, "messages" | "live"> {
	const entries = Object.entries(state.live);
	if (entries.length === 0) {
		return { messages: state.messages, live: state.live };
	}
	const liveIds = new Set(entries.map(([id]) => id));
	const kept = state.messages.filter((m) => !liveIds.has(m.id));
	const flushed: Message[] = entries.map(([, m]) => ({
		id: m.id,
		sessionId: state.sessionId,
		role: m.role,
		parts: m.parts,
		// Explicitly ungroupable: a live entry is already one whole turn's worth
		// of parts (see `mergeRenderedMessages`), and this is a stopgap for the
		// `loadHistory()` right after, which replaces it with the DB row carrying
		// the real `turnId`.
		turnId: null,
		createdAt: m.startedAt,
	}));
	return { messages: [...kept, ...flushed], live: {} };
}

/** Remove one optimistic entry by temp id. Returns the same state when it is
 * already gone — a resync can have cleared it first. */
function withdrawLive(state: ChatState, tempId: string): ChatState {
	if (!(tempId in state.live)) return state;
	const live = { ...state.live };
	delete live[tempId];
	return { ...state, live };
}
