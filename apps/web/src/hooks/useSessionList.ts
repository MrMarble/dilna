import type {
	RateLimitWindow,
	SessionListEvent,
	SessionView,
} from "@dilna/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";

/**
 * Every Session's live state, across every Repo — issue #174.
 *
 * One cross-Session SSE subscription (ADR-0008) is the source of truth for the
 * `sessionsById` map: the server pushes a `session_status` for every Session
 * on connect and on every transition, so there is no separate list fetch to
 * race against. The stream is opened exactly once per app load and never
 * reconnected on re-render, which is why the two notification callbacks are
 * required to be referentially stable (see the `useEffect` note below).
 *
 * Three event types fold in here:
 *
 * - `session_status` — upsert into the map, then hand the Session to
 *   `onSessionStatus` so the unread badges (issue #52) see the same
 *   transition.
 * - `session_deleted` — drop it from the map and call `onSessionForgotten`,
 *   so a deleted Session can't leave a stale unread badge keeping the bell's
 *   aggregate count inflated.
 * - `rate_limits` — the provider's current windows, rendered in the sidebar.
 *
 * Local mutations (`upsert`/`remove`) exist because a Session created or
 * deleted by *this* client shouldn't wait for its own event to round-trip
 * before the UI moves: `upsert` puts a freshly-created Session in the map so
 * the caller can navigate to it in the same tick, and `remove` drops one whose
 * DELETE has already been confirmed. Both are idempotent with the stream — an
 * arriving event simply re-applies the same edit.
 *
 * The groupings are derived, not stored, so they can't drift from the map:
 * `sessionsByRepoId` (the Sidebar's per-Repo submenu),
 * `backgroundSessions` (non-idle Sessions other than the selected one) and
 * `orchestratorSessions`. Orchestrator Sessions are global rather than
 * Repo-scoped (ADR-0021), so they're excluded from `sessionsByRepoId` and
 * `backgroundSessions` and listed on their own — they belong to a hidden
 * meta-Repo that never appears in the Repo list.
 */
export function useSessionList({
	selectedSessionId,
	onSessionStatus,
	onSessionForgotten,
}: {
	selectedSessionId: string | null;
	/// Called for every `session_status` event. Must be referentially stable:
	/// the stream is opened once and listing it as a dependency would
	/// reconnect the SSE stream on every render.
	onSessionStatus: (session: SessionView) => void;
	/// Called when a Session is deleted server-side. Same stability rule.
	onSessionForgotten: (sessionId: string) => void;
}) {
	const [sessionsById, setSessionsById] = useState<Record<string, SessionView>>(
		{},
	);
	const [rateLimitWindows, setRateLimitWindows] = useState<RateLimitWindow[]>(
		[],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the stream is opened once; onSessionStatus/onSessionForgotten are contractually stable (see the prop docs) and read mutable/selected state through refs, so listing them would needlessly reconnect the SSE stream.
	useEffect(() => {
		const unsubscribe = api.sessionList.stream((ev: SessionListEvent) => {
			if (ev.type === "session_status") {
				setSessionsById((prev) => ({ ...prev, [ev.session.id]: ev.session }));
				onSessionStatus(ev.session);
			} else if (ev.type === "session_deleted") {
				setSessionsById((prev) => {
					if (!(ev.sessionId in prev)) return prev;
					const next = { ...prev };
					delete next[ev.sessionId];
					return next;
				});
				onSessionForgotten(ev.sessionId);
			} else if (ev.type === "rate_limits") {
				setRateLimitWindows(ev.windows);
			}
		});
		return unsubscribe;
	}, []);

	const upsert = useCallback((session: SessionView) => {
		setSessionsById((prev) => ({ ...prev, [session.id]: session }));
	}, []);

	const remove = useCallback((sessionId: string) => {
		setSessionsById((prev) => {
			if (!(sessionId in prev)) return prev;
			const next = { ...prev };
			delete next[sessionId];
			return next;
		});
	}, []);

	// Every Repo's Sessions, newest-active first — the Sidebar's per-Repo
	// submenu only ever renders the selected Repo's list, but keeping this
	// pre-grouped means switching Repos needs neither a fetch nor a re-filter
	// of every Session on every render.
	const sessionsByRepoId = useMemo(() => {
		const map: Record<string, SessionView[]> = {};
		for (const session of Object.values(sessionsById)) {
			if (session.kind === "orchestrator") continue;
			let list = map[session.repoId];
			if (!list) {
				list = [];
				map[session.repoId] = list;
			}
			list.push(session);
		}
		for (const sessions of Object.values(map)) {
			sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
		}
		return map;
	}, [sessionsById]);

	const backgroundSessions = useMemo(
		() =>
			Object.values(sessionsById)
				.filter(
					(s) =>
						s.kind !== "orchestrator" &&
						s.id !== selectedSessionId &&
						s.status !== "idle",
				)
				.sort((a, b) => b.lastActiveAt - a.lastActiveAt),
		[sessionsById, selectedSessionId],
	);

	// The Sidebar's own top-level "Orchestrator" section — not nested under a
	// Repo (it's global, ADR-0021), so it isn't part of sessionsByRepoId.
	const orchestratorSessions = useMemo(
		() =>
			Object.values(sessionsById)
				.filter((s) => s.kind === "orchestrator")
				.sort((a, b) => b.lastActiveAt - a.lastActiveAt),
		[sessionsById],
	);

	return {
		sessionsById,
		rateLimitWindows,
		sessionsByRepoId,
		backgroundSessions,
		orchestratorSessions,
		/// Add or replace a Session locally, ahead of its own stream event —
		/// used right after this client creates one.
		upsert,
		/// Drop a Session locally, after this client's DELETE was confirmed.
		remove,
	};
}
