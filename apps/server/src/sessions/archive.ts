import { desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { sessionArchive as sessionArchiveTable } from "../db/schema";

export type ArchivedSessionSummary = {
	sessionId: string;
	repoId: string;
	title: string;
	createdAt: number;
	archivedAt: number;
};

export type ArchivedSession = ArchivedSessionSummary & { summary: string };

/** Write path for `session_archive` (ADR-0024) — the one place
 * `SessionManager.delete` inserts an archive row, called just before it
 * hard-deletes the Session's own `messages`/`sessions` rows. */
export function archiveSession(row: {
	sessionId: string;
	repoId: string;
	title: string;
	summary: string;
	createdAt: number;
}): void {
	getDb().insert(sessionArchiveTable).values(row).run();
}

/** Backs the orchestrator's `dilna_list_archived_sessions` tool — metadata
 * only, no summary text, to keep the tool result bounded (same reasoning as
 * `dilna_list_sessions` excluding a transcript dump). */
export function listArchivedSessions(
	repoId?: string,
): ArchivedSessionSummary[] {
	const db = getDb();
	const rows = repoId
		? db
				.select()
				.from(sessionArchiveTable)
				.where(eq(sessionArchiveTable.repoId, repoId))
				.orderBy(desc(sessionArchiveTable.archivedAt))
				.all()
		: db
				.select()
				.from(sessionArchiveTable)
				.orderBy(desc(sessionArchiveTable.archivedAt))
				.all();
	return rows.map(({ summary: _summary, ...rest }) => rest);
}

/** Backs the orchestrator's `dilna_get_archived_session` tool. `null` for an
 * id that was never archived — either unknown, or a Session deleted before
 * it had any messages (nothing to summarize, per
 * `summarizeSessionForArchive`). */
export function getArchivedSession(sessionId: string): ArchivedSession | null {
	const row = getDb()
		.select()
		.from(sessionArchiveTable)
		.where(eq(sessionArchiveTable.sessionId, sessionId))
		.get();
	return row ?? null;
}
