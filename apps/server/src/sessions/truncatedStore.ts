import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Message } from "@dilna/shared";
import { TOOL_OUTPUT_POLICY } from "@dilna/shared";
import { lt } from "drizzle-orm";
import { getDataDir, getDb } from "../db";
import { truncatedOutputs as truncatedOutputsTable } from "../db/schema";
import { logger } from "../logger";

/**
 * The on-disk store for the full original behind a trimmed tool output
 * (issue #273): `<DILNA_DATA_DIR>/truncated/<sha256>.txt`, named by the hash
 * the trim marker carries, so a person reading the transcript can recover
 * the original with no tooling at all — and the chat UI can link to it
 * (`GET /api/truncated/:hash`, plain read-only text).
 *
 * Two decisions #273 left open, settled here:
 *
 * - **Keyed by hash alone, not session+hash.** Identical content trimmed in
 *   any Session is one file and one row (`storeTruncated` is write-if-absent
 *   on both), so two trims of the same content can never diverge, and the
 *   store needs no per-Session cleanup story.
 * - **Pruned by age, not by Session deletion.** Entries older than
 *   {@link TRUNCATED_RETENTION_DAYS} are swept at server boot
 *   ({@link pruneTruncated}) — restarts are the natural cadence of a
 *   long-lived instance, and an age bound is what actually stops growth,
 *   since content-addressing makes a deleted Session's files potentially
 *   shared with live ones. Session deletion deliberately leaves the store
 *   alone.
 *
 * The agent-facing hydration tool is deliberately not part of this (#274's
 * measurement decides whether agents need one): the agent can always re-read
 * the original path itself, and the trim marker tells it that doing so is a
 * no-op when the hash matches.
 */

const log = logger.child({ component: "sessions/truncatedStore" });

/** How long a stored original survives without being re-trimmed. */
export const TRUNCATED_RETENTION_DAYS = 30;

export function getTruncatedDir(): string {
	return path.join(getDataDir(), "truncated");
}

export type StoredTruncation = {
	hash: string;
	tool: string;
	path: string | null;
	sessionId: string;
	originalChars: number;
	originalLines: number;
	/** The full original text. */
	content: string;
};

/**
 * Persist one trimmed output's original. Content-addressed and idempotent:
 * the file is written only when absent and the row is INSERT OR IGNORE, so
 * identical content trimmed any number of times — across turns or across
 * Sessions — is stored exactly once.
 */
export function storeTruncated(stored: StoredTruncation): void {
	const dir = getTruncatedDir();
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${stored.hash}.txt`);
	if (!existsSync(file)) {
		writeFileSync(file, stored.content);
	}
	getDb()
		.insert(truncatedOutputsTable)
		.values({
			hash: stored.hash,
			tool: stored.tool,
			path: stored.path,
			sessionId: stored.sessionId,
			originalChars: stored.originalChars,
			originalLines: stored.originalLines,
		})
		.onConflictDoNothing()
		.run();
}

/** The full original for a hash, or `null` when nothing was stored. */
export function readTruncated(hash: string): string | null {
	const file = path.join(getTruncatedDir(), `${hash}.txt`);
	if (!existsSync(file)) return null;
	return readFileSync(file, "utf8");
}

/** Whether the store holds this content (drives the row's provenance upsert
 * semantics in tests and the UI's link availability). */
export function hasTruncated(hash: string): boolean {
	return existsSync(path.join(getTruncatedDir(), `${hash}.txt`));
}

/**
 * Store the originals for one turn's persisted tool outputs (called by
 * `SessionManager` after a turn's rows are durably persisted — issue #273).
 * Only outputs large enough for the policy to ever trim them are stored;
 * storage is content-addressed, so repeated writes collapse into the first
 * file. Verbatim by construction: this reads the just-persisted rows, it
 * does not touch them.
 */
export function storeTruncationsForRows(
	sessionId: string,
	rows: Message[],
): void {
	for (const row of rows) {
		if (row.role !== "assistant") continue;
		for (const part of row.parts) {
			if (part.type !== "tool_call") continue;
			const output = typeof part.output === "string" ? part.output : "";
			// The size floor the policy can ever trim below — smaller outputs
			// never need an original on disk (dedup markers for small repeats
			// reference content that is still verbatim in the transcript).
			if (
				output.length < TOOL_OUTPUT_POLICY.minChars &&
				output.split("\n").length < TOOL_OUTPUT_POLICY.minLines
			) {
				continue;
			}
			const POLICY_TOOLS = new Set(["read", "grep", "find", "bash"]);
			if (!POLICY_TOOLS.has(part.tool)) continue;
			storeTruncated({
				hash: sha256Hex(output),
				tool: part.tool,
				path:
					part.input && typeof part.input === "object" && "path" in part.input
						? String((part.input as Record<string, unknown>).path)
						: null,
				sessionId,
				originalChars: output.length,
				originalLines: output.split("\n").length,
				content: output,
			});
		}
	}
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Sweep entries older than {@link TRUNCATED_RETENTION_DAYS}: rows gone and
 * files unlinked. Called at server boot — a restart is the natural moment
 * for a bounded, once-per-process sweep, and it is what keeps a long-lived
 * instance's `truncated/` directory from growing forever (which is also
 * what answers "deleted Sessions don't leak their originals forever": the
 * bound is age, not Session liveness).
 */
export function pruneTruncated(now = Date.now()): number {
	const db = getDb();
	const cutoff = Math.floor(now / 1000) - TRUNCATED_RETENTION_DAYS * 86_400;
	const stale = db
		.select({ hash: truncatedOutputsTable.hash })
		.from(truncatedOutputsTable)
		.where(lt(truncatedOutputsTable.createdAt, cutoff))
		.all();
	if (stale.length === 0) return 0;
	for (const { hash } of stale) {
		rmSync(path.join(getTruncatedDir(), `${hash}.txt`), { force: true });
	}
	db.delete(truncatedOutputsTable)
		.where(lt(truncatedOutputsTable.createdAt, cutoff))
		.run();
	log.info({ pruned: stale.length }, "pruned truncated originals");
	return stale.length;
}
