import type { SessionCacheTurn } from "@dilna/shared";
import { useEffect, useState } from "react";
import { api } from "@/api/client";

/**
 * Rolling per-turn cache split for a Session (issue #271) — feeds the
 * context card's cache-instability warning. Seeded from
 * `GET /api/sessions/:id`'s `recentCacheTurns` (the last few completed
 * turns, oldest last, from `usage_events`), then extended live: the
 * turn-end `usage_update` carries the turn's full usage in its `usage`
 * field (the server only rewrites `cumulative` to the lifetime token
 * total — the cache columns survive), so each reconciling event appends
 * one turn wholesale. Window capped at 5 to match the seed.
 */
export function useSessionCacheTurns(sessionId: string): SessionCacheTurn[] {
	const [turns, setTurns] = useState<SessionCacheTurn[]>([]);

	useEffect(() => {
		setTurns([]);
		let cancelled = false;
		api.sessions
			.get(sessionId)
			.then(({ recentCacheTurns }) => {
				if (!cancelled) setTurns(recentCacheTurns);
			})
			.catch(() => {
				// seed is best-effort; live events still keep this honest
			});
		const unsubscribe = api.sessions.stream(sessionId, (ev) => {
			if (ev.type === "usage_update" && ev.cumulative) {
				const turn: SessionCacheTurn = {
					readTokens: ev.usage.cacheReadTokens ?? 0,
					writeTokens: ev.usage.cacheWriteTokens ?? 0,
				};
				setTurns((prev) => [...prev, turn].slice(-5));
			}
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [sessionId]);

	return turns;
}
