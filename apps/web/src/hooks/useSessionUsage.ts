import type { UsageTotals } from "@dilna/shared";
import { useEffect, useState } from "react";
import { api } from "@/api/client";

const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0 };

function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
	};
}

/**
 * Live cumulative token usage for a Session (issue #10 — no cost, per
 * ADR-0006's additive `usage_update` event). Keeps its own SSE subscription
 * rather than threading usage state through ChatShell's existing
 * message-streaming state, so any consumer (the header's `UsageBadge`, the
 * mobile Changed-files sheet) stays a small, self-contained addition.
 *
 * `baseline` is the last authoritative session-lifetime total — seeded from
 * the session's persisted `usage` on mount (so a reload or session switch
 * picks up where the session left off instead of restarting at 0), then
 * snapped forward by each turn-end `usage_update` carrying `cumulative`
 * (which the server rewrites to the same persisted total). `delta`
 * accumulates the per-message deltas of the turn in progress, since usage on
 * individual assistant messages isn't cumulative across the multiple API
 * calls a turn can span (see docs/research/claude-agent-sdk-usage-limits.md).
 */
export function useSessionUsage(sessionId: string): UsageTotals {
	const [baseline, setBaseline] = useState<UsageTotals>(ZERO_USAGE);
	const [delta, setDelta] = useState<UsageTotals>(ZERO_USAGE);

	useEffect(() => {
		setBaseline(ZERO_USAGE);
		setDelta(ZERO_USAGE);
		let cancelled = false;
		api.sessions
			.get(sessionId)
			.then(({ session }) => {
				if (cancelled) return; // session switched while the seed was in flight
				// Don't clobber a cumulative that streamed in while this fetch was
				// in flight — the reference-identity check works because only this
				// seed path ever sees the pristine ZERO_USAGE object.
				setBaseline((prev) => (prev === ZERO_USAGE ? session.usage : prev));
			})
			.catch(() => {
				// seed is best-effort; live events still keep the total honest
			});
		const unsubscribe = api.sessions.stream(sessionId, (ev) => {
			if (ev.type === "session_status" && ev.status === "working") {
				// New turn starting — start summing fresh deltas on top of the
				// last reconciled baseline.
				setDelta(ZERO_USAGE);
			} else if (ev.type === "usage_update") {
				if (ev.cumulative) {
					setBaseline(ev.cumulative);
					setDelta(ZERO_USAGE);
				} else {
					setDelta((prev) => addUsage(prev, ev.usage));
				}
			}
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [sessionId]);

	return addUsage(baseline, delta);
}
