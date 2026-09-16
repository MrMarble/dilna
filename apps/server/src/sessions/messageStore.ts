import type { Message, MessagePart } from "@dilna/shared";
import { and, asc, eq, max } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "../db";
import { messages as messagesTable } from "../db/schema";

/**
 * Every read/write dilna performs against the `messages` table, in one
 * place — extracted from `SessionManager` (issue #149) so the turn state
 * machine composes a persistence collaborator rather than owning raw
 * drizzle statements inline.
 *
 * Deliberately free functions over a class, matching the rest of
 * `sessions/` (`archive.ts`, `diff.ts`, `usageStats.ts`): there is no
 * per-instance state to hold — `getDb()` is the singleton — and free
 * functions keep the module directly callable from tests without
 * constructing anything.
 *
 * Scope boundary: this module knows about rows only. It never broadcasts,
 * never touches turn state, and never decides *when* a message should be
 * written — those stay in `SessionManager`. The one piece of domain policy
 * that lives here is the pending-user placeholder protocol
 * ({@link pendingUserMessageId} / {@link promotePendingUserMessage}), which
 * is inseparable from the row shape it operates on.
 */

/** Persist one message row verbatim. Throws on a primary-key collision —
 * callers that may legitimately re-persist known content go through
 * {@link persistConverted}, which dedups by id first.
 *
 * Assigns the row's `seq` (this Session's next write-order slot) as part of
 * the insert. Read-then-insert is safe against concurrent turns because
 * better-sqlite3 is synchronous and every multi-row caller already wraps
 * this in a transaction — there is no `await` between the max and the
 * insert for another turn to interleave into. */
export function persistMessage(sessionId: string, message: Message): void {
	getDb()
		.insert(messagesTable)
		.values({
			id: message.id,
			sessionId,
			role: message.role,
			partsJson: JSON.stringify(message.parts),
			turnId: message.turnId ?? null,
			createdAt: message.createdAt,
			seq: nextSeq(sessionId),
		})
		.run();
}

/** The next write-order slot for a Session. `max(seq) + 1`, starting at 1. */
function nextSeq(sessionId: string): number {
	const row = getDb()
		.select({ max: max(messagesTable.seq) })
		.from(messagesTable)
		.where(eq(messagesTable.sessionId, sessionId))
		.get();
	return (row?.max ?? 0) + 1;
}

/** A Session's full durable history, oldest first. The DB is the source of
 * truth for history (ADR-0004/0014) — this is what every render, export and
 * agent re-seed reads from.
 *
 * Ordered by `seq` (write order), not `createdAt`. `createdAt` is epoch
 * *seconds*, so rows written in the same second tie — and a tie has no
 * defined order in SQL, which made the rendered transcript's order an
 * accident of SQLite's query plan. Sub-agents working in parallel make
 * same-second writes routine rather than rare. `createdAt` is still what
 * gets rendered; it just no longer decides position. */
export function getMessages(sessionId: string): Message[] {
	const rows = getDb()
		.select()
		.from(messagesTable)
		.where(eq(messagesTable.sessionId, sessionId))
		.orderBy(asc(messagesTable.seq))
		.all();
	return rows.map((row) => ({
		id: row.id,
		sessionId: row.sessionId,
		role: row.role as Message["role"],
		parts: JSON.parse(row.partsJson) as MessagePart[],
		turnId: row.turnId,
		createdAt: row.createdAt,
	}));
}

export function deleteMessage(sessionId: string, messageId: string): void {
	getDb()
		.delete(messagesTable)
		.where(
			and(
				eq(messagesTable.sessionId, sessionId),
				eq(messagesTable.id, messageId),
			),
		)
		.run();
}

/** Drop a Session's entire history. Called from `SessionManager.delete`,
 * inside the same transaction that removes the `sessions` row. */
export function deleteMessagesForSession(sessionId: string): void {
	getDb()
		.delete(messagesTable)
		.where(eq(messagesTable.sessionId, sessionId))
		.run();
}

/** Stable id for the one-per-session placeholder row that stands in for
 * the user's message while its turn is still in progress (see
 * `SessionManager.beginTurn`). A session has at most one in-flight turn at
 * a time, so this id never needs to be unique per-turn. */
export function pendingUserMessageId(sessionId: string): string {
	return `pending-user-${sessionId}`;
}

/**
 * Rename the pending-user placeholder into a permanent row (fresh unique
 * id, content and timestamp untouched) instead of deleting it. Used when
 * a turn ended without the transcript recording the user's message —
 * crash before the init handshake, interrupted first turn, unreadable
 * transcript — so the message is never lost, and the stable per-session
 * placeholder id is freed for the next turn. No-op when no placeholder
 * row exists.
 */
export function promotePendingUserMessage(sessionId: string): void {
	getDb()
		.update(messagesTable)
		.set({ id: nanoid() })
		.where(
			and(
				eq(messagesTable.sessionId, sessionId),
				eq(messagesTable.id, pendingUserMessageId(sessionId)),
			),
		)
		.run();
}

/**
 * Persist every converted turn row dilna doesn't already have.
 *
 * Only ever receives *assistant* rows: `piMessagesToDilna` no longer mints
 * user rows from the agent transcript, because dilna already owns the user's
 * message as the `pending-user-<sessionId>` placeholder `beginTurn` wrote.
 * Converting them here re-persisted messages dilna already had (fresh UUIDs
 * defeat the dedup below) carrying timestamps from a previous turn. The
 * user's row now has exactly one writer.
 *
 * Timestamps are written through untouched. This used to shift the whole
 * batch above the newest stored row's `createdAt` to keep it sorting last,
 * because `createdAt` *was* the sort key — a repair that mutated displayed
 * times to express ordering, and that a stale re-offered row could hijack
 * into reordering the transcript. Ordering is now carried by `seq`, assigned
 * in write order by {@link persistMessage}, so a row sorts where it was
 * written regardless of what clock stamped it and there is nothing to repair.
 *
 * The id-based dedup here only catches rows dilna itself has seen before by
 * id; it cannot recognize re-converted content, because both pi→dilna
 * converters mint fresh UUIDs. Keeping an overlapping retry slice from
 * duplicating rounds is therefore the *caller's* job — see `TurnLedger`
 * (`sessions/turnLedger.ts`) and issue #190.
 */
export function persistConverted(
	sessionId: string,
	converted: Message[],
): void {
	const existing = new Set(getMessages(sessionId).map((m) => m.id));
	const fresh = converted.filter((msg) => !existing.has(msg.id));
	if (fresh.length === 0) return;

	getDb().transaction(() => {
		for (const msg of fresh) {
			persistMessage(sessionId, msg);
		}
	});
}
