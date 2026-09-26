import type { UsageTotalsDetailed } from "@dilna/shared";
import { formatTokenCount } from "@/lib/tokens";

/**
 * Presentation helpers for the Metrics page's cache-health panel (issue
 * #266) — the baseline instrument that makes a Session paying a cache-write
 * premium every turn distinguishable from a healthy cached one, before
 * anything changes how dilna builds a prompt.
 *
 * The rate itself is computed server-side (`usageStats.ts`, one formula for
 * every slice); these helpers only decide how a rate *reads*: its tier
 * color, its rendered form, and its tooltip copy.
 */

/**
 * Semantic color for a hit rate, on the same 50/80 cutoffs as the other
 * meters (`rate-limits.ts`, `context-usage.ts`) but inverted: here HIGH is
 * the good direction, so a healthy (≥80%) rate is success, 50–80% is
 * warning, and below 50% — a Session mostly paying cache *writes* every
 * turn — is danger. `null` (nothing to measure) is muted rather than
 * danger, so an empty/new instance never reads as "every turn missed".
 * Text tokens, not raw palette classes, so they follow the theme.
 */
export function cacheHealthTone(hitRate: number | null): string {
	if (hitRate === null) return "text-muted-foreground";
	if (hitRate < 0.5) return "text-danger";
	if (hitRate < 0.8) return "text-warning";
	return "text-success";
}

/** Bar-fill counterpart of {@link cacheHealthTone} for the per-day trend,
 * same cutoffs; `null` maps to `bg-idle`, but the trend renders null days as
 * empty slots rather than bars (see `CacheTrend`). */
export function cacheHealthBarColor(hitRate: number | null): string {
	if (hitRate === null) return "bg-idle";
	if (hitRate < 0.5) return "bg-danger";
	if (hitRate < 0.8) return "bg-warning";
	return "bg-success";
}

/** "84.2%" — one decimal so the write/read ratio trend stays readable at a
 * glance; "—" for a slice with no input-side tokens (never "0.0%", which
 * would read as every-turn-miss rather than nothing-to-measure). */
export function formatHitRate(hitRate: number | null): string {
	return hitRate === null ? "—" : `${(hitRate * 100).toFixed(1)}%`;
}

/** Full tooltip for one slice: what the number measures, and — for the
 * write-heavy tiers — what it's telling you (the prefix keeps missing and
 * re-paying; on dilna's byte-stable prefix that points at cold starts,
 * restarts or compaction, not mid-session rebuilds). */
export function cacheHealthTooltip(
	hitRate: number | null,
	readTokens: number,
	writeTokens: number,
	uncachedInputTokens: number,
): string {
	const raw =
		`cache reads ${formatTokenCount(readTokens)} · ` +
		`writes ${formatTokenCount(writeTokens)} · ` +
		`uncached in ${formatTokenCount(uncachedInputTokens)}`;
	if (hitRate === null) return `Nothing to measure — ${raw}`;
	const pct = formatHitRate(hitRate);
	if (hitRate < 0.5)
		return `${pct} hit rate — mostly cache writes: the prompt prefix keeps missing and re-paying. ${raw}`;
	if (hitRate < 0.8) return `${pct} hit rate — partially cached. ${raw}`;
	return `${pct} hit rate — healthy: most of the prompt is served from cache. ${raw}`;
}

/** Type guard narrowing a breakdown row to the raw components a tooltip
 * needs — every `UsageSummary` slice carries them via `UsageTotalsDetailed`. */
export type CacheSlice = Pick<
	UsageTotalsDetailed,
	"cacheHitRate" | "cacheReadTokens" | "cacheWriteTokens" | "inputTokens"
>;
