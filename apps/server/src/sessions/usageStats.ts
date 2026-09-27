import type {
	UsageDailyModelBreakdown,
	UsageDailyPoint,
	UsageModelBreakdown,
	UsagePurposeBreakdown,
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
	cacheHitRate: null,
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

/**
 * Cache hit rate over one slice of `usage_events` (issue #266): cache reads
 * over everything the prompt side cost — read + write + uncached input
 * (`input_tokens` is the non-cached portion; cache tokens are recorded
 * separately). The denominator deliberately excludes output/reasoning:
 * compaction-eligible output doesn't tell you anything about whether the
 * *prompt prefix* was reused. `null` when the slice has no input-side
 * tokens — an empty range, or a slice of output-only rows — so callers can
 * render "—" instead of a misleading 0% (0% would read as "every turn was
 * a cache miss" when it really means "nothing to measure").
 *
 * Worth knowing while reading it: dilna's request prefix is byte-stable
 * across the turns of a *live* Session, so a healthy-looking rate on a warm
 * Session is expected; invalidation shows up across cold starts (idle kill,
 * restart, post-compaction respawn), which is what the write-side of the
 * ratio is there to expose.
 */
function cacheHitRateOf(row: {
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}): number | null {
	const denominator =
		row.cacheReadTokens + row.cacheWriteTokens + row.inputTokens;
	return denominator > 0 ? row.cacheReadTokens / denominator : null;
}

/** Attach the slice's computed hit rate to one aggregate row — the raw
 * components are already in `SUM_COLUMNS`' output, the rate is derived, so
 * it's stamped on after the query rather than summed in SQL. Takes the raw
 * sums shape (not `UsageTotalsDetailed`) because that's what the SQL rows
 * are before the stamp. */
function withCacheHitRate<
	T extends {
		inputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
	},
>(row: T): T & { cacheHitRate: number | null } {
	return { ...row, cacheHitRate: cacheHitRateOf(row) };
}

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
		.all()
		.map(withCacheHitRate) as UsageDailyPoint[];

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
		.all()
		.map(withCacheHitRate) as UsageDailyModelBreakdown[];

	const byRepo = db
		.select({ repoId: usageEventsTable.repoId, ...SUM_COLUMNS })
		.from(usageEventsTable)
		.where(where)
		.groupBy(usageEventsTable.repoId)
		.all()
		.map(withCacheHitRate) as UsageRepoBreakdown[];
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
		.all()
		.map(withCacheHitRate) as UsageModelBreakdown[];
	byModel.sort((a, b) => b.costUsd - a.costUsd);

	const topSessions = getTopSessions(where);

	// Judge spend (ADR-0046) is folded into every aggregate above — it's real
	// spend on a real model — and split out only here, so the dashboard can say
	// how much of the total went on scoring rather than on Agent turns.
	const byPurpose = db
		.select({ purpose: usageEventsTable.purpose, ...SUM_COLUMNS })
		.from(usageEventsTable)
		.where(where)
		.groupBy(usageEventsTable.purpose)
		.all()
		.map(withCacheHitRate) as UsagePurposeBreakdown[];

	return {
		totals: withCacheHitRate(totals ?? { ...ZERO_TOTALS }),
		daily,
		dailyByModel,
		byRepo,
		byModel,
		topSessions,
		byPurpose,
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
		.all()
		.map(withCacheHitRate) as (UsageTotalsDetailed & {
		sessionId: string;
		repoId: string;
	})[];
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
