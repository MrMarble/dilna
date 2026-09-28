import type { UsageTruncation } from "@dilna/shared";
import { desc, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
	sessionArchive as sessionArchiveTable,
	sessions as sessionsTable,
	truncationEvents as truncationEventsTable,
} from "../db/schema";

/**
 * Recording and aggregating the truncation trade (issue #274): one row in
 * `truncation_events` per counted event, and the `UsageSummary.truncation`
 * aggregates the Metrics page reads savings and cost from.
 *
 * The three kinds and their dedup semantics live on the schema's doc
 * comment (`db/schema.ts`): `trim` rows are per seed walk (every cold start
 * genuinely re-sends the trimmed form, so it genuinely saves the delta
 * again), `retrieval` rows are per request, and `reread` rows dedupe per
 * (session, call id) via the unique index, so the seed walk and the
 * transcript walk can both report the same re-read without double counting
 * — whichever sees it first records it, and the fact is on the books.
 *
 * Like `usage_events`, the rows deliberately outlive their Session: a
 * deleted Session's counts still appear, titled from its `session_archive`
 * row (ADR-0024).
 */

export type TruncationEventInput = {
	sessionId: string;
	kind: "trim" | "retrieval" | "reread";
	hash: string;
	/** The trimmed part's call id — carries the dedup semantics above. */
	callId?: string;
	/** Seed-time estimate of input tokens saved (kind `"trim"` only). */
	tokensSaved?: number;
};

/** Insert one counted event. Rereads rely on the unique index to collapse
 * repeats (`onConflictDoNothing`); no other kind ever collides (their
 * `call_id` is null, and SQLite treats NULLs as distinct in a unique
 * index). */
export function recordTruncationEvent(event: TruncationEventInput): void {
	getDb()
		.insert(truncationEventsTable)
		.values({
			sessionId: event.sessionId,
			kind: event.kind,
			hash: event.hash,
			callId: event.callId ?? null,
			tokensSaved: event.tokensSaved ?? 0,
		})
		.onConflictDoNothing()
		.run();
}

/** Aggregates for `GET /api/usage`'s `truncation` field. `since` bounds the
 * slice like every other usage aggregate. */
export function getTruncationSummary(since: number): UsageTruncation {
	const db = getDb();
	const where = gte(truncationEventsTable.createdAt, since);

	const byKind = db
		.select({
			kind: truncationEventsTable.kind,
			count: sql<number>`count(*)`,
			tokensSaved: sql<number>`coalesce(sum(${truncationEventsTable.tokensSaved}), 0)`,
		})
		.from(truncationEventsTable)
		.where(where)
		.groupBy(truncationEventsTable.kind)
		.all();

	const summary: UsageTruncation = {
		retrievals: 0,
		rereads: 0,
		tokensSaved: 0,
		bySession: [],
	};
	for (const row of byKind) {
		if (row.kind === "retrieval") summary.retrievals = row.count;
		if (row.kind === "reread") summary.rereads = row.count;
		if (row.kind === "trim") summary.tokensSaved = row.tokensSaved;
	}

	// Per-Session breakdown — most savings first, so a too-aggressive
	// policy conversation starts from the Session with skin in the game.
	summary.bySession = db
		.select({
			sessionId: truncationEventsTable.sessionId,
			retrievals: sql<number>`coalesce(sum(case when ${truncationEventsTable.kind} = 'retrieval' then 1 else 0 end), 0)`,
			rereads: sql<number>`coalesce(sum(case when ${truncationEventsTable.kind} = 'reread' then 1 else 0 end), 0)`,
			tokensSaved: sql<number>`coalesce(sum(${truncationEventsTable.tokensSaved}), 0)`,
		})
		.from(truncationEventsTable)
		.where(where)
		.groupBy(truncationEventsTable.sessionId)
		.orderBy(desc(sql`sum(${truncationEventsTable.tokensSaved})`))
		.all()
		.map((row) => ({ ...row, title: null as string | null }));

	const ids = summary.bySession.map((s) => s.sessionId);
	if (ids.length > 0) {
		const titleById = resolveSessionTitles(ids);
		for (const row of summary.bySession) {
			row.title = titleById.get(row.sessionId) ?? null;
		}
	}

	return summary;
}

/** Resolve display titles for Session ids against whichever of the live
 * `sessions` row or the deleted Session's `sessionArchive` row (ADR-0024)
 * still exists — the shared rule behind the top-sessions table and this
 * module's per-Session breakdown, so a deleted Session's counts stay
 * labelled. Live rows win; neither source means the caller renders
 * "unknown". */
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
