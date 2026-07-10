import type { UsageTotals } from "@dilna/shared";
import { useEffect, useState } from "react";
import { api } from "@/api/client";

type Props = {
	sessionId: string;
};

const ZERO_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0 };

function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
	};
}

/**
 * Tokens-only usage badge for the chat header (issue #10 — no cost, per
 * ADR-0006's additive `usage_update` event). Deliberately keeps its own SSE
 * subscription rather than threading usage state through ChatShell's
 * existing message-streaming state, so this stays a small, self-contained
 * addition next to the Agent badge in ChatHeader.
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
export function UsageBadge({ sessionId }: Props) {
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
				// Don't clobber a cumulative that streamed in while this fetch
				// was in flight — the reference-identity check works because only
				// this seed path ever sees the pristine ZERO_USAGE object.
				setBaseline((prev) => (prev === ZERO_USAGE ? session.usage : prev));
			})
			.catch(() => {
				// seed is best-effort; live events still keep the badge honest
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

	const total = addUsage(baseline, delta);
	const totalTokens = total.inputTokens + total.outputTokens;

	return (
		<span
			className="rounded-full border border-border px-2 py-0.5 text-xs tabular-nums text-muted-foreground"
			title={`Input ${total.inputTokens.toLocaleString()} · Output ${total.outputTokens.toLocaleString()}`}
		>
			Tokens · {formatTokenCount(totalTokens)}
		</span>
	);
}

function formatTokenCount(n: number): string {
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}
