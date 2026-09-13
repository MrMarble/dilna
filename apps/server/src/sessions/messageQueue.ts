import type { Attachment, QueuedMessage } from "@dilna/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "../db";
import { queuedMessages as queuedMessagesTable } from "../db/schema";

/**
 * Every read/write dilna performs against the `queued_messages` table
 * (ADR-0033), in one place — free functions over a class, matching
 * `messageStore.ts` and the rest of `sessions/` (ADR-0027's decomposition
 * style): `getDb()` is the singleton and there is no per-instance state.
 *
 * Scope boundary: rows only. This module never broadcasts and never decides
 * *when* the queue drains — enqueue/dispatch policy (and the `queue_update`
 * broadcasts that accompany every change) live in `SessionManager`, the one
 * layer that owns the turn lifecycle the queue keys off.
 */

function rowToQueued(row: {
	id: string;
	sessionId: string;
	text: string;
	attachmentsJson: string;
	createdAt: number;
}): QueuedMessage {
	return {
		id: row.id,
		sessionId: row.sessionId,
		text: row.text,
		attachments: JSON.parse(row.attachmentsJson) as Attachment[],
		createdAt: row.createdAt,
	};
}

/** Append one entry. `attachments` are already resolved/ownership-checked
 * records (the route does that at enqueue, exactly as the send route does),
 * snapshotted into the row — see the schema comment for why a snapshot is
 * safe here. */
export function enqueueMessage(
	sessionId: string,
	text: string,
	attachments: Attachment[],
): QueuedMessage {
	const entry: QueuedMessage = {
		id: nanoid(),
		sessionId,
		text,
		attachments,
		createdAt: Math.floor(Date.now() / 1000),
	};
	getDb()
		.insert(queuedMessagesTable)
		.values({
			id: entry.id,
			sessionId,
			text,
			attachmentsJson: JSON.stringify(attachments),
			createdAt: entry.createdAt,
		})
		.run();
	return entry;
}

/** A Session's queue, oldest first — submission order is dispatch order.
 * Ordered by SQLite's implicit `rowid` (insertion order), not `createdAt`:
 * the timestamp has second granularity, so two quick enqueues tie and
 * would fall back to comparing random ids — exactly the reordering the
 * queue exists to prevent. */
export function listQueuedMessages(sessionId: string): QueuedMessage[] {
	return getDb()
		.select()
		.from(queuedMessagesTable)
		.where(eq(queuedMessagesTable.sessionId, sessionId))
		.orderBy(asc(sql`rowid`))
		.all()
		.map(rowToQueued);
}

/** Remove one entry (the user withdrew it before dispatch). Returns whether
 * a row was actually deleted — false means it was already gone, typically
 * because a dispatch won the race; callers treat that as success, since
 * either way the entry is no longer queued. */
export function removeQueuedMessage(
	sessionId: string,
	queuedId: string,
): boolean {
	const res = getDb()
		.delete(queuedMessagesTable)
		.where(
			and(
				eq(queuedMessagesTable.sessionId, sessionId),
				eq(queuedMessagesTable.id, queuedId),
			),
		)
		.run();
	return res.changes > 0;
}

/** Delete exactly these entries — the dispatch path's clear. By id rather
 * than "everything for the Session" so an entry enqueued *between* a
 * dispatch's read and its clear survives to the next drain instead of being
 * silently swallowed. */
export function removeQueuedMessagesById(
	sessionId: string,
	ids: string[],
): void {
	if (ids.length === 0) return;
	getDb()
		.delete(queuedMessagesTable)
		.where(
			and(
				eq(queuedMessagesTable.sessionId, sessionId),
				inArray(queuedMessagesTable.id, ids),
			),
		)
		.run();
}

/** Drop a Session's whole queue — part of Session deletion. */
export function deleteQueueForSession(sessionId: string): void {
	getDb()
		.delete(queuedMessagesTable)
		.where(eq(queuedMessagesTable.sessionId, sessionId))
		.run();
}
