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
 * `baseline` is the last authoritative cumulative total (from a turn-end
 * `usage_update` carrying `cumulative`); `delta` accumulates the per-message
 * deltas of the turn in progress, since usage on individual assistant
 * messages isn't cumulative across the multiple API calls a turn can span
 * (see docs/research/claude-agent-sdk-usage-limits.md). Resets to zero on
 * session change via the `sessionId` effect dependency — a fresh session
 * with no turns yet renders 0, never an error state.
 */
export function UsageBadge({ sessionId }: Props) {
	const [baseline, setBaseline] = useState<UsageTotals>(ZERO_USAGE);
	const [delta, setDelta] = useState<UsageTotals>(ZERO_USAGE);

	useEffect(() => {
		setBaseline(ZERO_USAGE);
		setDelta(ZERO_USAGE);
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
		return unsubscribe;
	}, [sessionId]);

	const total = addUsage(baseline, delta);
	const totalTokens = total.inputTokens + total.outputTokens;

	return (
		<span
			className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-muted-foreground dark:border-zinc-800"
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
