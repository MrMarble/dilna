/**
 * Response shapes for `GET /api/usage` — dilna's cost/token dashboard
 * (`sessions/usageStats.ts` on the server, `MetricsPage` on the web side).
 * Sourced from the `usage_events` table (one row per turn), independent of
 * the per-session `UsageTotals` badge contract in `events.ts`.
 */
export type UsageTotalsDetailed = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	costUsd: number;
	/** Cache hit rate over this slice (issue #266): `cacheRead / (cacheRead
	 * + cacheWrite + uncached input)` — the baseline instrument for the
	 * prefix-freeze work, so the effect of any prompt-change is measured
	 * rather than asserted. Computed server-side (`usageStats.ts`) so the
	 * formula and its empty-slice policy live in one place; `null` when the
	 * slice has no input-side tokens at all. Callers render "—" for null,
	 * never 0% — 0 would read as "every turn missed" rather than "nothing to
	 * measure". */
	cacheHitRate: number | null;
};

/** `date` is a UTC `YYYY-MM-DD` bucket (SQLite `date(created_at, 'unixepoch')`). */
export type UsageDailyPoint = { date: string } & UsageTotalsDetailed;

export type UsageRepoBreakdown = { repoId: string } & UsageTotalsDetailed;

export type UsageModelBreakdown = {
	provider: string;
	model: string;
} & UsageTotalsDetailed;

/** Same `date` bucket as `UsageDailyPoint`, split by `provider`/`model` — powers the stacked-by-model daily chart. */
export type UsageDailyModelBreakdown = {
	date: string;
	provider: string;
	model: string;
} & UsageTotalsDetailed;

/**
 * One of the top-spending Sessions in range (`usageStats.ts`'s
 * `TOP_SESSIONS_LIMIT`). `title` is resolved server-side against the live
 * `sessions` row or, for a deleted Session, its `sessionArchive` row
 * (ADR-0024) — null only when neither exists (pre-archive-feature rows).
 */
export type UsageSessionBreakdown = {
	sessionId: string;
	repoId: string;
	title: string | null;
} & UsageTotalsDetailed;

/**
 * What a `usage_events` row paid for. `"turn"` is an ordinary Agent turn;
 * `"judge"` is an output-scoring call (ADR-0046) — real spend, so it counts
 * toward the totals, but kept apart here and out of the Session's own
 * `input_tokens`/`output_tokens` so a scored Session's numbers still
 * describe the work it did.
 */
export type UsagePurpose = "turn" | "judge";

export type UsagePurposeBreakdown = {
	purpose: UsagePurpose;
} & UsageTotalsDetailed;

/**
 * A Session whose context estimate persistently disagrees with what the
 * provider itself reports (issue #270) — surfaced on the Metrics page so a
 * mis-calibrated `charsPerToken` is identifiable without reading raw
 * `usage_events` rows. Only Sessions past `CONTEXT_DRIFT_THRESHOLD` (server
 * side, `usageStats.ts`) are listed, worst first.
 */
export type UsageContextDrift = {
	sessionId: string;
	repoId: string;
	/** Resolved server-side against the live `sessions` row or the
	 * `sessionArchive` row (ADR-0024) — same rule as `UsageSessionBreakdown`. */
	title: string | null;
	/** Signed mean of `(estimated − reported) / reported` over the Session's
	 * turns that carry both numbers. Positive = dilna over-counts (compacts
	 * early, throws away context it didn't need to); negative = dilna
	 * under-counts (the dangerous direction — the real window can overflow
	 * before the meter says so). */
	driftPct: number;
	/** How many turns the mean is over — a drift verdict on one turn is
	 * noise, on dozens is a calibration problem. */
	turns: number;
};

/**
 * The truncation trade, per Session (issue #274): what the seed-time trims
 * save versus what they cost. Sessions are listed only when they have at
 * least one counter or one stored original, so a policy-free instance shows
 * nothing. Deleted Sessions' counts still appear (title resolved against
 * the archive like `topSessions`) — the trade outlives the Session.
 */
export type UsageTruncation = {
	sessionId: string;
	repoId: string;
	title: string | null;
	/** Estimated tokens the seeder's trims remove from this Session's
	 * current-history seed (removedChars / 4, the estimator's own flat
	 * rate). Recomputed per request from the same walk the seeder runs. */
	savedTokens: number;
	/** Times a human opened the original from a trim marker. */
	retrievals: number;
	/** Times an agent re-read a path whose content hash the store already
	 * held — the cost of having trimmed something the model needed. */
	rereads: number;
};

/** Aggregate of the per-Session numbers, plus the totals. */
export type UsageTruncationSummary = {
	savedTokens: number;
	retrievals: number;
	rereads: number;
	bySession: UsageTruncation[];
};

export type UsageSummary = {
	totals: UsageTotalsDetailed;
	daily: UsageDailyPoint[];
	dailyByModel: UsageDailyModelBreakdown[];
	byRepo: UsageRepoBreakdown[];
	byModel: UsageModelBreakdown[];
	topSessions: UsageSessionBreakdown[];
	byPurpose: UsagePurposeBreakdown[];
	/** Sessions whose estimate vs provider-report drift is past the warn
	 * threshold, worst first; empty when every estimator is honest (or no
	 * turn carries both numbers yet). */
	contextDrift: UsageContextDrift[];
	/** The truncation trade (issue #274): savings vs retrieval/re-read
	 * cost, read together in one glance. */
	truncation: UsageTruncationSummary;
};

/**
 * Filesystem capacity for the volume backing `DILNA_DATA_DIR` — total and
 * free bytes, read live via `fs.statfs`. `usedPct` is free/available over
 * the *currently reported available* bytes, not over `total`, because the
 * filesystem can reserve blocks (e.g. ext4) that aren't usable by this
 * process; basing the bar on `total` would understate real headroom.
 */
export type DiskUsage = {
	totalBytes: number;
	freeBytes: number;
};
