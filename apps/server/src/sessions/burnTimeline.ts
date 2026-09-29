import type { SessionBurnTurn, UsagePurpose } from "@dilna/shared";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { resolveSummarizationModel } from "../agents/pi";
import { getDb } from "../db";
import {
	messages as messagesTable,
	sessions as sessionsTable,
	usageEvents as usageEventsTable,
} from "../db/schema";

/**
 * The Session's burn timeline (issue #293) — every `usage_events` row of one
 * Session, oldest first, as the context panel's burn tab renders it. One
 * Session-scoped query; the data is everything the turn-end accounting
 * (`usageAccounting.ts`) already stamps, plus the model catalog's context
 * window so the two occupancy figures have a scale. No capture changes, no
 * schema changes: a Session's history is answerable from rows that already
 * exist.
 *
 * Turn ordinals and the compaction marker need the `messages` table (the
 * usage rows don't carry a turn id), but only as two point lookups, not a
 * join — see {@link compactionTurnOrdinal}.
 */
export function getBurnTimeline(sessionId: string): SessionBurnTurn[] {
	const db = getDb();
	const rows = db
		.select({
			purpose: usageEventsTable.purpose,
			inputTokens: usageEventsTable.inputTokens,
			outputTokens: usageEventsTable.outputTokens,
			cacheReadTokens: usageEventsTable.cacheReadTokens,
			cacheWriteTokens: usageEventsTable.cacheWriteTokens,
			reasoningTokens: usageEventsTable.reasoningTokens,
			costUsd: usageEventsTable.costUsd,
			providerContextTokens: usageEventsTable.providerContextTokens,
			estimatedContextTokens: usageEventsTable.estimatedContextTokens,
			provider: usageEventsTable.provider,
			model: usageEventsTable.model,
			createdAt: usageEventsTable.createdAt,
		})
		.from(usageEventsTable)
		.where(eq(usageEventsTable.sessionId, sessionId))
		// `createdAt` is second-resolution, so same-second turns tie; rowid is
		// insertion order, which is turn-completion order — the tiebreak the
		// ordinals depend on.
		.orderBy(asc(usageEventsTable.createdAt), sql`rowid`)
		.all();
	if (rows.length === 0) return [];

	const compactionTurn = compactionTurnOrdinal(db, sessionId);

	let turn = 0;
	return rows.map((row) => {
		const isTurn = row.purpose === "turn";
		if (isTurn) turn += 1;
		return {
			turn: isTurn ? turn : null,
			at: row.createdAt,
			purpose: row.purpose as UsagePurpose,
			inputTokens: row.inputTokens,
			outputTokens: row.outputTokens,
			cacheReadTokens: row.cacheReadTokens,
			cacheWriteTokens: row.cacheWriteTokens,
			reasoningTokens: row.reasoningTokens,
			costUsd: row.costUsd,
			providerContextTokens: row.providerContextTokens ?? null,
			estimatedContextTokens: row.estimatedContextTokens ?? null,
			contextWindow:
				resolveSummarizationModel(row.provider, row.model)?.contextWindow ??
				null,
			compacted: isTurn && turn === compactionTurn,
		};
	});
}

/**
 * Which 1-based turn ordinal the Session's current compaction landed on —
 * the turn containing `compactedThroughMessageId`. `null` when the Session
 * was never compacted, or the pointer dangles (no matching `messages` row in
 * *this* Session — the pointer is deliberately FK-free, same tolerance as
 * `usage_events`' ids).
 *
 * The ordinal counts distinct `messages.turnId` values up to the pointer's
 * seq, i.e. every turn *started* up to that message. A turn that started but
 * never completed (crash/timeout) contributes to this count while having no
 * `usage_events` row, so the marker can land a row late in that case — a
 * tolerated, cosmetic-only drift: the marker names the turn whose history
 * the summary replaced, and compaction only ever runs after a turn that did
 * complete (`checkContextAndCompact` sits on the normal-end path).
 */
function compactionTurnOrdinal(
	db: ReturnType<typeof getDb>,
	sessionId: string,
): number | null {
	const session = db
		.select({ through: sessionsTable.compactedThroughMessageId })
		.from(sessionsTable)
		.where(eq(sessionsTable.id, sessionId))
		.get();
	if (!session?.through) return null;

	// Scoped by sessionId as well as id: a message id is only meaningful
	// within its own Session, and a dangling pointer must degrade to "no
	// marker", never to a marker on the wrong turn.
	const anchor = db
		.select({ seq: messagesTable.seq })
		.from(messagesTable)
		.where(
			and(
				eq(messagesTable.id, session.through),
				eq(messagesTable.sessionId, sessionId),
			),
		)
		.get();
	if (!anchor || anchor.seq === null) return null;

	// COUNT(DISTINCT turn_id): null turnIds (boot-time system notices,
	// pre-#30 rows) don't count as turns.
	const counted = db
		.select({
			n: sql<number>`count(distinct ${messagesTable.turnId})`.as("n"),
		})
		.from(messagesTable)
		.where(
			and(
				eq(messagesTable.sessionId, sessionId),
				lte(messagesTable.seq, anchor.seq),
			),
		)
		.get();
	const n = counted?.n ?? 0;
	return n > 0 ? n : null;
}
