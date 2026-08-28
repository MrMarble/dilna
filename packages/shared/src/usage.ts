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

export type UsageSummary = {
	totals: UsageTotalsDetailed;
	daily: UsageDailyPoint[];
	byRepo: UsageRepoBreakdown[];
	byModel: UsageModelBreakdown[];
};
