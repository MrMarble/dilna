import type { Message, MessagePart } from "@dilna/shared";
import { and, asc, eq } from "drizzle-orm";
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
 * {@link persistConverted}, which dedups by id first. */
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
		})
		.run();
}

/** A Session's full durable history, oldest first. The DB is the source of
 * truth for history (ADR-0004/0014) — this is what every render, export and
 * agent re-seed reads from. */
export function getMessages(sessionId: string): Message[] {
	const rows = getDb()
		.select()
		.from(messagesTable)
		.where(eq(messagesTable.sessionId, sessionId))
		.orderBy(asc(messagesTable.createdAt))
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
 * Persist every converted turn row dilna doesn't already have, reconciling
 * timestamps against what's already stored. Returns whether a user-role row
 * was among the freshly persisted ones — `runTurn` uses that to decide the
 * pending-user placeholder's fate (drop vs promote).
 *
 * The id-based dedup here only catches rows dilna itself has seen before by
 * id; it cannot recognize re-converted content, because both pi→dilna
 * converters mint fresh UUIDs. Keeping an overlapping retry slice from
 * duplicating rounds is therefore the *caller's* job — see
 * `ActiveAgent.persistedRounds` and issue #190.
 */
export function persistConverted(
	sessionId: string,
	converted: Message[],
): { persistedUserMessage: boolean } {
	const persisted = getMessages(sessionId);
	const existing = new Set(persisted.map((m) => m.id));
	const fresh = converted.filter((msg) => !existing.has(msg.id));
	if (fresh.length === 0) return { persistedUserMessage: false };

	// Rows persisted before the past-stamping fix (a legacy claude.ts-era
	// artifact) can carry timestamps minutes in the future; shift this
	// batch above them so createdAt ordering stays monotonic for legacy
	// sessions (drift then shrinks to nothing as wall clock catches up).
	const pendingId = pendingUserMessageId(sessionId);
	const maxExisting = Math.max(
		0,
		...persisted.filter((m) => m.id !== pendingId).map((m) => m.createdAt),
	);
	const minFresh = Math.min(...fresh.map((m) => m.createdAt));
	if (minFresh <= maxExisting) {
		const shift = maxExisting + 1 - minFresh;
		for (const msg of fresh) msg.createdAt += shift;
	}

	// The pending placeholder row (written at send time) still wins for
	// its exact createdAt when it doesn't break monotonic ordering, so a
	// client that already rendered the placeholder doesn't see it jump
	// position on reload — its *id* is always dropped below regardless
	// (a fresh id from piMessagesToDilna takes its place).
	const pending = persisted.find((m) => m.id === pendingId);
	const turnUserRow = fresh.filter((m) => m.role === "user").at(-1);
	if (pending && turnUserRow) {
		const idx = fresh.indexOf(turnUserRow);
		const prevStamp = idx > 0 ? (fresh[idx - 1]?.createdAt ?? 0) : maxExisting;
		if (pending.createdAt >= prevStamp) {
			turnUserRow.createdAt = pending.createdAt;
		}
	}

	getDb().transaction(() => {
		for (const msg of fresh) {
			persistMessage(sessionId, msg);
		}
	});
	return { persistedUserMessage: fresh.some((m) => m.role === "user") };
}
