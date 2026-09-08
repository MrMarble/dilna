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

export type UsageSummary = {
	totals: UsageTotalsDetailed;
	daily: UsageDailyPoint[];
	dailyByModel: UsageDailyModelBreakdown[];
	byRepo: UsageRepoBreakdown[];
	byModel: UsageModelBreakdown[];
	topSessions: UsageSessionBreakdown[];
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
