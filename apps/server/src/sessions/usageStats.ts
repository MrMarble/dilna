import type {
	UsageDailyModelBreakdown,
	UsageDailyPoint,
	UsageModelBreakdown,
	UsageRepoBreakdown,
	UsageSessionBreakdown,
	UsageSummary,
	UsageTotalsDetailed,
} from "@dilna/shared";
import { gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
	sessionArchive as sessionArchiveTable,
	sessions as sessionsTable,
	usageEvents as usageEventsTable,
} from "../db/schema";

/** How many top-spending Sessions the "Top sessions" table shows. */
const TOP_SESSIONS_LIMIT = 10;

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

	const dailyByModel = db
		.select({
			date: DAY_BUCKET,
			provider: usageEventsTable.provider,
			model: usageEventsTable.model,
			...SUM_COLUMNS,
		})
		.from(usageEventsTable)
		.where(where)
		.groupBy(DAY_BUCKET, usageEventsTable.provider, usageEventsTable.model)
		.orderBy(DAY_BUCKET)
		.all() as UsageDailyModelBreakdown[];

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
	byModel.sort((a, b) => b.costUsd - a.costUsd);

	const topSessions = getTopSessions(where);

	return {
		totals: totals ?? { ...ZERO_TOTALS },
		daily,
		dailyByModel,
		byRepo,
		byModel,
		topSessions,
	};
}

/**
 * Top-spending Sessions in range, with a display title resolved against
 * whichever of `sessions`/`sessionArchive` still has a row for that id —
 * `usage_events` deliberately has no FK to either (see its schema comment),
 * so a Session can be deleted (hard-deleted from `sessions`, archived into
 * `sessionArchive` per ADR-0024) without losing its historical spend here.
 */
function getTopSessions(
	where: ReturnType<typeof gte>,
): UsageSessionBreakdown[] {
	const db = getDb();

	const bySession = db
		.select({
			sessionId: usageEventsTable.sessionId,
			repoId: usageEventsTable.repoId,
			...SUM_COLUMNS,
		})
		.from(usageEventsTable)
		.where(where)
		.groupBy(usageEventsTable.sessionId, usageEventsTable.repoId)
		.all() as (UsageTotalsDetailed & { sessionId: string; repoId: string })[];
	bySession.sort((a, b) => b.costUsd - a.costUsd);
	const top = bySession.slice(0, TOP_SESSIONS_LIMIT);
	if (top.length === 0) return [];

	const ids = top.map((s) => s.sessionId);
	const titleById = new Map<string, string>();
	for (const row of db
		.select({
			id: sessionArchiveTable.sessionId,
			title: sessionArchiveTable.title,
		})
		.from(sessionArchiveTable)
		.where(inArray(sessionArchiveTable.sessionId, ids))
		.all()) {
		titleById.set(row.id, row.title);
	}
	// Live sessions win over an archive row for the same id (shouldn't both
	// exist, but a live row is the fresher source of truth if they do).
	for (const row of db
		.select({ id: sessionsTable.id, title: sessionsTable.title })
		.from(sessionsTable)
		.where(inArray(sessionsTable.id, ids))
		.all()) {
		titleById.set(row.id, row.title);
	}

	return top.map((s) => ({ ...s, title: titleById.get(s.sessionId) ?? null }));
}
