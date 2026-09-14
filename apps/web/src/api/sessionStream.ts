import type { AgentStreamEvent } from "@dilna/shared";

/**
 * Every `AgentStreamEvent` type, as an exhaustive map rather than a
 * hand-written array.
 *
 * The `Record<AgentStreamEvent["type"], true>` annotation is the point: a new
 * variant in `packages/shared/src/events.ts` fails to typecheck here until
 * it's listed, so it cannot be silently dropped. That mattered even with one
 * `EventSource` per consumer — `context_usage` and `artefact_published` were
 * both missing from the old array, so no listener was ever registered and
 * those handlers were dead code — and it matters more now: with a shared
 * connection this registry is the *only* place listeners get attached, so an
 * omission takes out every subscriber at once rather than one.
 */
const SESSION_EVENT_TYPE_MAP: Record<AgentStreamEvent["type"], true> = {
	session_status: true,
	changed_files: true,
	artefact_published: true,
	user_message: true,
	queue_update: true,
	message_start: true,
	token: true,
	thinking: true,
	tool_call_start: true,
	tool_call_end: true,
	message_end: true,
	turn_failed: true,
	notice: true,
	turn_activity: true,
	resync: true,
	usage_update: true,
	context_usage: true,
};

export const SESSION_EVENT_TYPES = Object.keys(
	SESSION_EVENT_TYPE_MAP,
) as AgentStreamEvent["type"][];

/** What a subscriber supplies. All three callbacks are optional so a consumer
 * that only cares about, say, `context_usage` doesn't have to care about
 * connection state at all. */
export type SessionStreamSubscriber = {
	onEvent?: (event: AgentStreamEvent) => void;
	/** The ADR-0016 §4 resync point: reset live-turn state and refetch.
	 *
	 * Fires on the underlying connection's first open, on every reconnect —
	 * and immediately on subscribe if the connection is *already* open. That
	 * last case is what makes join order irrelevant: a panel mounted mid-turn
	 * has still missed everything before it subscribed, so it needs the same
	 * resync a first-connect subscriber gets. Without it, a late subscriber
	 * would wait for the next reconnect to ever load its data. */
	onOpen?: () => void;
	onConnectionChange?: (connected: boolean) => void;
};

/** Opens the transport. Injected so tests can drive a fake connection
 * directly, and so this module stays independent of `EventSource`. */
export type SessionStreamTransport = (
	sessionId: string,
	eventTypes: readonly string[],
	onEvent: (event: AgentStreamEvent) => void,
	onOpen: () => void,
	onConnectionChange: (connected: boolean) => void,
) => () => void;

type Connection = {
	subscribers: Set<SessionStreamSubscriber>;
	close: () => void;
	/** Whether the transport is currently open — drives the immediate-`onOpen`
	 * for late subscribers, and seeds their `onConnectionChange`. */
	connected: boolean;
};

/**
 * One SSE connection per Session, fanned out to N subscribers (issue #202).
 *
 * Four consumers used to each call `api.sessions.stream()` for the same
 * Session, which meant four `EventSource`s to one URL, four server-side
 * subscribers, four opening-snapshot replays, and four independent
 * reconnect/backoff state machines that could disagree about whether the
 * stream was alive. "Am I connected?" now has one answer.
 *
 * Connections are reference-counted per `sessionId`: the transport opens on
 * the first subscriber and closes on the last. That, rather than a
 * process-wide singleton, is what the consumers actually need — they mount
 * and unmount independently, and the open Session changes as the user
 * switches chats, so a connection's lifetime is tied to "does anyone still
 * care about this Session" and nothing else.
 *
 * The seam is unchanged: this sits *behind* `api.sessions.stream`, so the
 * ADR-0016 §4 resync contract is the same one callers already coded against
 * — it just fires once per Session instead of four racing times.
 */
export class SessionStreamHub {
	private readonly connections = new Map<string, Connection>();

	constructor(private readonly transport: SessionStreamTransport) {}

	subscribe(
		sessionId: string,
		subscriber: SessionStreamSubscriber,
	): () => void {
		const connection = this.connections.get(sessionId) ?? this.open(sessionId);
		connection.subscribers.add(subscriber);

		// Late subscriber on an already-live connection: it missed the real
		// `open`, so give it the resync now (see `onOpen`'s note). Deliberately
		// after the `add` above, so a resync that itself subscribes or
		// unsubscribes sees a consistent set.
		if (connection.connected) {
			subscriber.onConnectionChange?.(true);
			subscriber.onOpen?.();
		}

		let unsubscribed = false;
		return () => {
			// Idempotent: React can invoke a cleanup more than once, and a
			// double-unsubscribe must not drop the connection out from under the
			// subscribers that are still attached.
			if (unsubscribed) return;
			unsubscribed = true;
			const current = this.connections.get(sessionId);
			if (!current) return;
			current.subscribers.delete(subscriber);
			if (current.subscribers.size === 0) {
				this.connections.delete(sessionId);
				current.close();
			}
		};
	}

	/** Open connections, for assertions in tests. */
	get openSessionIds(): string[] {
		return [...this.connections.keys()];
	}

	private open(sessionId: string): Connection {
		const connection: Connection = {
			subscribers: new Set(),
			connected: false,
			close: () => {},
		};
		// Registered before `transport` runs: a synchronous open (any fake, and
		// in principle a cached real one) would otherwise fan out to a
		// connection not yet in the map.
		this.connections.set(sessionId, connection);

		connection.close = this.transport(
			sessionId,
			SESSION_EVENT_TYPES,
			(event) => {
				// Snapshot before iterating: a handler may subscribe or unsubscribe
				// (ChatShell's `resync` does), and mutating the Set mid-iteration
				// would otherwise skip or double-deliver.
				for (const s of [...connection.subscribers]) s.onEvent?.(event);
			},
			() => {
				connection.connected = true;
				for (const s of [...connection.subscribers]) s.onOpen?.();
			},
			(connected) => {
				connection.connected = connected;
				for (const s of [...connection.subscribers]) {
					s.onConnectionChange?.(connected);
				}
			},
		);
		return connection;
	}
}
