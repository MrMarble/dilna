/**
 * Sidebar helpers for the `context_usage` SSE event (ADR-0023's addendum):
 * how close a Session's live context is to crossing its compaction budget
 * threshold (`contextWindow - reserveTokens`), not the raw context window.
 */

/** Percentage of the way from empty to the compaction trigger point —
 * distinct from raw `tokens / contextWindow`, since compaction fires before
 * the window is actually full (it reserves `reserveTokens` for its own
 * summarization call). Clamped to [0, 100] since a turn can briefly land
 * past the trigger point before the same check compacts it back down. */
export function contextUsagePct(
	tokens: number,
	contextWindow: number,
	reserveTokens: number,
): number {
	const trigger = Math.max(1, contextWindow - reserveTokens);
	return Math.max(0, Math.min(100, (tokens / trigger) * 100));
}

/** Same three-tier thresholds as `rate-limits.ts`'s `rateLimitBarColor`
 * (neutral below 50%, amber 50-80%, red above 80%) — kept as its own
 * function rather than shared, since the two meters track unrelated
 * quantities (account-wide plan usage vs. one Session's context budget)
 * that only happen to share a color convention. */
export function contextUsageBarColor(pct: number): string {
	if (pct > 80) return "bg-red-500";
	if (pct >= 50) return "bg-amber-500";
	return "bg-zinc-400 dark:bg-zinc-500";
}

/** True once a Session is close enough to its compaction trigger that the
 * sidebar should say so explicitly, not just color the bar — same 80%
 * cutoff as the bar's red tier. */
export function isNearCompaction(pct: number): boolean {
	return pct > 80;
}
