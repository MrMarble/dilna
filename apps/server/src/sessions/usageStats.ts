import type {
	UsageContextDrift,
	UsageDailyModelBreakdown,
	UsageDailyPoint,
	UsageModelBreakdown,
	UsagePurposeBreakdown,
	UsagePurposeModelBreakdown,
	UsageRepoBreakdown,
	UsageSessionBreakdown,
	UsageSummary,
	UsageToolBreakdown,
	UsageTotalsDetailed,
} from "@dilna/shared";
import { and, eq, gt, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
	sessionArchive as sessionArchiveTable,
	sessions as sessionsTable,
	usageEvents as usageEventsTable,
} from "../db/schema";
import { getBurnFindings } from "./burnFindings";

/** How many top-spending Sessions the "Top sessions" table shows. */
const TOP_SESSIONS_LIMIT = 10;

/** How many drifted Sessions the drift list shows, worst first. */
const CONTEXT_DRIFT_LIMIT = 10;

/** Mean signed |drift| past which a Session is flagged on the Metrics page
 * (issue #270) and the per-turn drift log fires (`usageAccounting.ts`).
 * 25%: well above per-turn noise (a trailing message or two), well below
 * the ~2x error a wrong calibration constant can produce. */
export const CONTEXT_DRIFT_THRESHOLD = 0.25;

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
	const contextDrift = getContextDrift(where);
	const toolUsage = getToolUsage(where);

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

	// Where the side spend went, model by model (issue #311): the evidence
	// that routing it to the `cheap` role actually moved it.
	const byPurposeModel = db
		.select({
			purpose: usageEventsTable.purpose,
			provider: usageEventsTable.provider,
			model: usageEventsTable.model,
			calls: sql<number>`count(*)`,
			...SUM_COLUMNS,
		})
		.from(usageEventsTable)
		.where(and(where, ne(usageEventsTable.purpose, "turn")))
		.groupBy(
			usageEventsTable.purpose,
			usageEventsTable.provider,
			usageEventsTable.model,
		)
		.all()
		.map(withCacheHitRate) as UsagePurposeModelBreakdown[];
	byPurposeModel.sort((a, b) => b.costUsd - a.costUsd);

	// The judgment layer (issue #291): same range, same `usage_events`, one
	// home for the verdicts (`sessions/burnFindings.ts`) — the web renders
	// the shared shape and computes nothing.
	const burnFindings = getBurnFindings(since);

	return {
		totals: withCacheHitRate(totals ?? { ...ZERO_TOTALS }),
		daily,
		dailyByModel,
		byRepo,
		byModel,
		topSessions,
		byPurpose,
		byPurposeModel,
		contextDrift,
		burnFindings,
		toolUsage,
	};
}

/**
 * Per-tool/per-skill usage over the range (issue #292): call counts and
 * distinct Sessions per tool name, plus one row per skill loaded via
 * `read_skill`. Folded in JS rather than SQL — the facts live in a JSON
 * column there's no shape to GROUP BY, and the rows in range number in the
 * turns, so the fold is small. Rows without facts (pre-feature turns, judge
 * rows — see the column's schema comment) are excluded by the null check:
 * the capture is forward-only, and an old turn contributes nothing rather
 * than a fake zero. Sorted worst (most calls) first, name ascending to
 * break ties deterministically.
 */
function getToolUsage(where: ReturnType<typeof gte>): UsageToolBreakdown[] {
	const db = getDb();
	const rows = db
		.select({
			sessionId: usageEventsTable.sessionId,
			toolFactsJson: usageEventsTable.toolFactsJson,
		})
		.from(usageEventsTable)
		.where(
			and(
				where,
				// Structural, not incidental: judge rows are excluded by purpose,
				// not merely by "judge rows happen to carry no facts today". If a
				// future writer ever stamps facts onto a judge row, the Metrics
				// table must still not count judge calls as the Session's own
				// tool work — the same rule `purpose` encodes for the spend.
				eq(usageEventsTable.purpose, "turn"),
				isNotNull(usageEventsTable.toolFactsJson),
			),
		)
		.all();

	// Keyed by kind+name (a skill could in principle share a tool's name,
	// and the two rows answer different questions — "the bash tool was
	// called N times" vs "the skill named bash was loaded N times"); the
	// entry carries its own name so nothing decodes the key back apart.
	const seen = new Map<
		string,
		{
			name: string;
			kind: "tool" | "skill";
			calls: number;
			sessions: Set<string>;
		}
	>();
	const bump = (
		key: string,
		name: string,
		kind: "tool" | "skill",
		count: number,
		sessionId: string,
	) => {
		const entry = seen.get(key) ?? {
			name,
			kind,
			calls: 0,
			sessions: new Set(),
		};
		entry.calls += count;
		entry.sessions.add(sessionId);
		seen.set(key, entry);
	};

	for (const row of rows) {
		let facts: {
			tools?: Record<string, unknown>;
			skills?: Record<string, unknown>;
		};
		try {
			facts = JSON.parse(row.toolFactsJson as string);
		} catch {
			// dilna wrote this JSON itself, so this is corruption, not input —
			// degrade to skipping the row rather than failing the whole
			// dashboard for one bad row.
			continue;
		}
		for (const [name, count] of Object.entries(facts.tools ?? {})) {
			if (typeof count === "number" && count > 0) {
				bump(`tool:${name}`, name, "tool", count, row.sessionId);
			}
		}
		for (const [name, count] of Object.entries(facts.skills ?? {})) {
			if (typeof count === "number" && count > 0) {
				bump(`skill:${name}`, name, "skill", count, row.sessionId);
			}
		}
	}

	return [...seen.values()]
		.map(({ name, kind, calls, sessions }) => ({
			name,
			kind,
			calls,
			sessions: sessions.size,
		}))
		.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

/**
 * Sessions whose context estimate persistently disagrees with the
 * provider's own report (issue #270) — the per-turn drift
 * `usageAccounting.ts` stamps and logs, aggregated per Session so a
 * mis-calibrated `charsPerToken` is identifiable from the Metrics page
 * alone, without reading raw `usage_events` rows. Only Sessions past
 * {@link CONTEXT_DRIFT_THRESHOLD} are listed, worst (largest |drift|)
 * first, capped at {@link CONTEXT_DRIFT_LIMIT}; Sessions with no comparable
 * turns (rows missing either stamp) can't drift and aren't listed.
 */
function getContextDrift(where: ReturnType<typeof gte>): UsageContextDrift[] {
	const db = getDb();
	const rows = db
		.select({
			sessionId: usageEventsTable.sessionId,
			repoId: usageEventsTable.repoId,
			driftPct:
				sql`avg((${usageEventsTable.estimatedContextTokens} - ${usageEventsTable.providerContextTokens}) * 1.0 / ${usageEventsTable.providerContextTokens})`.as(
					"drift_pct",
				),
			turns: sql<number>`count(*)`.as("turns"),
		})
		.from(usageEventsTable)
		.where(
			and(
				where,
				isNotNull(usageEventsTable.estimatedContextTokens),
				isNotNull(usageEventsTable.providerContextTokens),
				gt(usageEventsTable.providerContextTokens, 0),
			),
		)
		.groupBy(usageEventsTable.sessionId, usageEventsTable.repoId)
		.all() as {
		sessionId: string;
		repoId: string;
		driftPct: number;
		turns: number;
	}[];

	const drifted = rows.filter(
		(r) => Math.abs(r.driftPct) > CONTEXT_DRIFT_THRESHOLD,
	);
	drifted.sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct));
	const top = drifted.slice(0, CONTEXT_DRIFT_LIMIT);
	if (top.length === 0) return [];

	const titleById = resolveSessionTitles(top.map((r) => r.sessionId));
	return top.map((r) => ({
		sessionId: r.sessionId,
		repoId: r.repoId,
		title: titleById.get(r.sessionId) ?? null,
		driftPct: r.driftPct,
		turns: r.turns,
	}));
}

/**
 * Display title for each Session id, resolved against whichever of
 * `sessions`/`sessionArchive` still has a row — shared by the top-spend
 * table, the drift list, and the burn findings (all three outlive deletion
 * the same way; `usage_events` has no FK to either table).
 */
export function resolveSessionTitles(ids: string[]): Map<string, string> {
	const db = getDb();
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
	return titleById;
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
	const titleById = resolveSessionTitles(ids);

	return top.map((s) => ({ ...s, title: titleById.get(s.sessionId) ?? null }));
}
