import type {
	UsageDailyPoint,
	UsageModelBreakdown,
	UsageRepoBreakdown,
	UsageSummary,
	UsageTotalsDetailed,
} from "@dilna/shared";
import { gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { usageEvents as usageEventsTable } from "../db/schema";

const ZERO_TOTALS: UsageTotalsDetailed = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	reasoningTokens: 0,
	costUsd: 0,
};

// SUM() over an empty group returns NULL, not 0 — coalesce so every
// aggregate row (including the single all-time totals row on an empty
// table) comes back as real numbers, not nulls the caller has to guard.
const SUM_COLUMNS = {
	inputTokens: sql<number>`coalesce(sum(${usageEventsTable.inputTokens}), 0)`,
	outputTokens: sql<number>`coalesce(sum(${usageEventsTable.outputTokens}), 0)`,
	cacheReadTokens: sql<number>`coalesce(sum(${usageEventsTable.cacheReadTokens}), 0)`,
	cacheWriteTokens: sql<number>`coalesce(sum(${usageEventsTable.cacheWriteTokens}), 0)`,
	reasoningTokens: sql<number>`coalesce(sum(${usageEventsTable.reasoningTokens}), 0)`,
	costUsd: sql<number>`coalesce(sum(${usageEventsTable.costUsd}), 0)`,
};

const DAY_BUCKET = sql`date(${usageEventsTable.createdAt}, 'unixepoch')`;

/**
 * Aggregate `usage_events` (one row per turn — see
 * `SessionManager.accumulateSessionUsage`) for the `/api/usage` dashboard.
 * `since` is a unix-seconds lower bound on `created_at`; pass 0 for
 * all-time. better-sqlite3's driver is synchronous, so this is too — no
 * `async`/`await` needed despite every query hitting disk.
 */
export function getUsageSummary(since: number): UsageSummary {
	const db = getDb();
	const where = gte(usageEventsTable.createdAt, since);

	const totals = db
		.select(SUM_COLUMNS)
		.from(usageEventsTable)
		.where(where)
		.get();

	const daily = db
		.select({ date: DAY_BUCKET, ...SUM_COLUMNS })
		.from(usageEventsTable)
		.where(where)
		.groupBy(DAY_BUCKET)
		.orderBy(DAY_BUCKET)
		.all() as UsageDailyPoint[];

	const byRepo = db
		.select({ repoId: usageEventsTable.repoId, ...SUM_COLUMNS })
		.from(usageEventsTable)
		.where(where)
		.groupBy(usageEventsTable.repoId)
		.all() as UsageRepoBreakdown[];
	byRepo.sort((a, b) => b.costUsd - a.costUsd);

	const byModel = db
		.select({
			provider: usageEventsTable.provider,
			model: usageEventsTable.model,
			...SUM_COLUMNS,
		})
		.from(usageEventsTable)
		.where(where)
		.groupBy(usageEventsTable.provider, usageEventsTable.model)
		.all() as UsageModelBreakdown[];

	return {
		totals: totals ?? { ...ZERO_TOTALS },
		daily,
		byRepo,
		byModel,
	};
}
