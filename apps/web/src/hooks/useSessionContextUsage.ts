import type { ContextUsageEstimate } from "@dilna/shared";
import { useEffect, useState } from "react";
import { api } from "@/api/client";

/**
 * Live context-window occupancy for a Session (ADR-0023's addendum). Seeded
 * from `GET /api/sessions/:id`'s `contextUsage` field on mount (so a page
 * load or session switch shows the last-known number immediately), then
 * kept live via `context_usage` SSE events, which — unlike `usage_update` —
 * are self-contained snapshots rather than deltas, so each one simply
 * replaces the previous value wholesale.
 */
export function useSessionContextUsage(
	sessionId: string,
): ContextUsageEstimate | null {
	const [usage, setUsage] = useState<ContextUsageEstimate | null>(null);

	useEffect(() => {
		setUsage(null);
		let cancelled = false;
		api.sessions
			.get(sessionId)
			.then(({ contextUsage }) => {
				if (!cancelled) setUsage(contextUsage);
			})
			.catch(() => {
				// seed is best-effort; a live turn still keeps this honest
			});
		const unsubscribe = api.sessions.stream(sessionId, (ev) => {
			if (ev.type === "context_usage") {
				setUsage({
					tokens: ev.tokens,
					contextWindow: ev.contextWindow,
					reserveTokens: ev.reserveTokens,
				});
			}
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [sessionId]);

	return usage;
}
