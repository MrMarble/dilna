import type { SessionBurnTurn } from "@dilna/shared";
import { useEffect, useState } from "react";
import { api } from "@/api/client";

/**
 * Per-Session burn timeline (issue #293) — seeds the context panel's burn
 * tab. The fetch-once / refetch-on-turn-end / never-poll policy and its
 * reasoning live on `BurnTimelineResponse` (both sides read it there); this
 * hook is its implementation. One detail not visible from the envelope:
 * judge-call rows (`purpose: "judge"`) are written outside the turn stream
 * (scoring is a request/response, not a broadcast), so one lands at the
 * next mount or turn-end refetch.
 */
export function useSessionBurnTimeline(
	sessionId: string,
): SessionBurnTurn[] | null {
	const [turns, setTurns] = useState<SessionBurnTurn[] | null>(null);

	useEffect(() => {
		setTurns(null);
		let cancelled = false;
		const fetchTimeline = () =>
			api.sessions
				.burnTimeline(sessionId)
				.then(({ turns: next }) => {
					if (!cancelled) setTurns(next);
				})
				.catch(() => {
					// Seed failure degrades to the tab's empty state rather than a
					// permanently blank card; a failed refresh keeps the last good
					// data — it's only stale until the next turn end.
					if (!cancelled) setTurns((prev) => prev ?? []);
				});
		fetchTimeline();
		const unsubscribe = api.sessions.stream(sessionId, (ev) => {
			if (ev.type === "usage_update" && ev.cumulative) void fetchTimeline();
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [sessionId]);

	return turns;
}
