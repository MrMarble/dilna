import type { AgentStreamEvent, SessionListEvent } from "@dilna/shared";

export type Listener = (event: AgentStreamEvent) => void;

/**
 * Subscriber bookkeeping and event fan-out, extracted from `SessionManager`
 * (issue #149): per-session SSE listeners, the cross-session status stream
 * (ADR-0008), and the small set of "last event of its kind" values that
 * exist purely so a subscriber joining mid-turn can be replayed the current
 * state (ADR-0016 §4/§5's snapshot rule).
 *
 * Why the retained events live here rather than beside the turn state: they
 * are not turn control state — nothing reads them to decide what the turn
 * does next. They exist only to answer "what would a client watching all
 * along have on screen right now", which is a question about broadcasting,
 * and keeping them next to the fan-out is what lets
 * {@link SessionBroadcaster.record} capture them on the way out instead of
 * making every call site remember to mirror its own event.
 *
 * Deliberately not a source of truth for anything durable: the DB holds
 * history, and this is a rendering optimization on top of it. Everything
 * here is in-memory and lost on restart, by design.
 */
export class SessionBroadcaster {
	/** Map of dilna session id -> SSE subscribers (browser tabs etc). Kept
	 * independent of the agent lifecycle so a UI tab can subscribe before
	 * any agent is running and still receive events once it starts. */
	private subscribers = new Map<string, Set<Listener>>();
	/** Cross-session status subscribers (per ADR-0008): one subscription per
	 * app load, notified on every status change of every session. */
	private globalSubscribers = new Set<(event: SessionListEvent) => void>();
	/** Last `turn_failed` broadcast per session, retained until the next
	 * accepted turn (`beginTurn` calls {@link clearTurnSnapshot}) so a client
	 * that subscribes after the failure — but before anything else happens —
	 * still sees why the session is `crashed`/`idle` instead of just the bare
	 * status (ADR-0016 §4's snapshot rule). */
	private lastTurnFailed = new Map<string, AgentStreamEvent>();
	/** The in-flight turn's current `turn_activity`/`notice`, mirrored here so
	 * a subscriber joining mid-turn sees them too (ADR-0016 §4/§5: both are
	 * "present in the opening snapshot only mid-turn") — otherwise a
	 * reconnecting tab renders nothing until the next discrete change.
	 * Cleared at accept and at turn end, same lifetime as
	 * `ActiveAgent.liveTurn`. */
	private lastTurnActivity = new Map<string, AgentStreamEvent>();
	private lastNotice = new Map<string, AgentStreamEvent>();

	/** Register a listener for one session's event stream. Returns the
	 * unsubscribe function. Callers that need the ADR-0016 §4 opening
	 * snapshot compose it themselves (see `SessionManager.subscribe`) — this
	 * only does the bookkeeping. */
	subscribe(id: string, listener: Listener): () => void {
		let subs = this.subscribers.get(id);
		if (!subs) {
			subs = new Set();
			this.subscribers.set(id, subs);
		}
		subs.add(listener);
		return () => {
			this.subscribers.get(id)?.delete(listener);
		};
	}

	/** Register a listener to receive a SessionListEvent whenever any
	 * session's status changes, across every repo. Powers the sidebar's
	 * Background Agents panel and the chat header's session dropdown (per
	 * ADR-0008) without the caller subscribing to each session individually. */
	subscribeAll(listener: (event: SessionListEvent) => void): () => void {
		this.globalSubscribers.add(listener);
		return () => {
			this.globalSubscribers.delete(listener);
		};
	}

	/** Fan an event out to one session's subscribers, retaining it first if
	 * it's one of the three snapshot-relevant kinds. Listener errors are
	 * non-fatal — one broken SSE connection must not abort the fan-out to
	 * everyone else. */
	broadcast(id: string, event: AgentStreamEvent): void {
		this.record(id, event);
		const subs = this.subscribers.get(id);
		if (!subs) return;
		for (const l of subs) {
			try {
				l(event);
			} catch {
				// listener errors during broadcast are non-fatal
			}
		}
	}

	broadcastGlobal(event: SessionListEvent): void {
		for (const l of this.globalSubscribers) {
			try {
				l(event);
			} catch {
				// listener errors during broadcast are non-fatal
			}
		}
	}

	/** Retain the snapshot-relevant events on their way out. Called by
	 * {@link broadcast}, so no call site has to remember to mirror its own
	 * event — the bug this shape prevents is an event reaching live
	 * subscribers but not the mid-turn replay path (or vice versa). */
	private record(id: string, event: AgentStreamEvent): void {
		switch (event.type) {
			case "turn_failed":
				this.lastTurnFailed.set(id, event);
				break;
			case "turn_activity":
				this.lastTurnActivity.set(id, event);
				break;
			case "notice":
				this.lastNotice.set(id, event);
				break;
			default:
				break;
		}
	}

	/**
	 * The session's most recent `turn_failed`, best-effort only: in-memory
	 * (per ADR-0016 §2, deliberately not persisted), cleared by the next
	 * accepted turn or lost on server restart. Callers that need failure
	 * detail to survive past that window must capture it while it's here —
	 * e.g. a transcript export taken before the session's next turn runs.
	 */
	getLastTurnFailed(
		id: string,
	): Extract<AgentStreamEvent, { type: "turn_failed" }> | undefined {
		const ev = this.lastTurnFailed.get(id);
		return ev?.type === "turn_failed" ? ev : undefined;
	}

	/** The mid-turn opening snapshot's `notice`/`turn_activity` pair, in the
	 * order ADR-0016 §4 specifies they be replayed. */
	midTurnSnapshot(id: string): AgentStreamEvent[] {
		const events: AgentStreamEvent[] = [];
		const notice = this.lastNotice.get(id);
		if (notice) events.push(notice);
		const activity = this.lastTurnActivity.get(id);
		if (activity) events.push(activity);
		return events;
	}

	/** Drop everything a new turn invalidates: a `turn_failed` is only
	 * "current" until the next accepted turn (ADR-0016 §4), and
	 * `turn_activity`/`notice` are valid only inside one turn (§5). Called at
	 * accept (`beginTurn`). */
	clearTurnSnapshot(id: string): void {
		this.lastTurnFailed.delete(id);
		this.lastTurnActivity.delete(id);
		this.lastNotice.delete(id);
	}

	/** Drop only the strictly in-turn events, keeping a `turn_failed` that
	 * must outlive the turn it ended. Called at turn end (`runTurn`). */
	clearInTurnSnapshot(id: string): void {
		this.lastTurnActivity.delete(id);
		this.lastNotice.delete(id);
	}
}
