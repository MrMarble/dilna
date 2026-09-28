import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { TrimmedToolOutput } from "@dilna/shared";
import { charsPerTokenFor } from "../agents/providerConfig";
import { getDataDir } from "../db";
import { recordTruncationEvent } from "./truncationEvents";

/**
 * The on-disk store of trimmed tool outputs (issue #273). When the seed-time
 * `ToolOutputPolicy` trims a tool result, the full original is written here —
 * `<DILNA_DATA_DIR>/truncated/<sha256-hex>` — so a truncated result stops
 * being lossy: the marker the model sees names the hash, and a human can
 * recover the exact bytes from the chat UI without an agent.
 *
 * ## Keyed by hash alone, not by session
 *
 * Identical content trimmed in two Sessions is one file, not two. That is the
 * deliberate choice: content-addressing makes every write idempotent (a
 * second trim of the same output is a no-op — there are never divergent
 * copies of one hash), dedupes the storage a trim-heavy instance generates,
 * and needs no cleanup story keyed to a Session. The cost is that a Session's
 * delete cannot name its files — another Session may reference the same
 * hash — so lifecycle is answered by age, not by ownership:
 *
 * ## Pruning: 30 days from write
 *
 * Entries are pruned 30 days after they were written
 * ({@link TRUNCATED_MAX_AGE_MS}), regardless of which Sessions still reference
 * them. A marker older than that may therefore no longer resolve — the
 * truncation marker itself (persisted in the transcript) still says what was
 * removed and its hash, so nothing is silently rewritten; only the recovery
 * link expires. That bound is what keeps this store from growing without end
 * on a long-lived instance, including originals belonging to Sessions deleted
 * long ago: they age out on the same clock as everything else. Pruning runs
 * at server boot and is throttled to once an hour on the write path, so a
 * busy instance never re-scans the directory per trim.
 *
 * ## Who writes
 *
 * Every caller that runs the seed walk — the cold-start seed in
 * `SessionManager.startAgent` *and* the `GET /:id/messages` transcript route
 * (the UI shows markers derived from persisted state, so the file must exist
 * by the time the link is on screen, possibly before the next cold start ever
 * runs). The write is content-addressed and idempotent, so this is a
 * cache-warming side effect, not a mutation: reading the transcript can
 * create the file a marker points at, never change what's in it.
 */
export const TRUNCATED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Between 30d prunes we don't re-walk the directory on every write. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** The store only ever holds sha256 hex digests — the exact form the
 * policy's hasher produces and the marker names. Enforcing the shape here
 * makes path traversal structurally impossible: anything else is rejected
 * before it can become a path segment. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function isValidTruncatedHash(hash: string): boolean {
	return HASH_PATTERN.test(hash);
}

/** `<DILNA_DATA_DIR>/truncated/<hash>` — the one place a path is built. */
export function truncatedPathFor(hash: string): string {
	if (!isValidTruncatedHash(hash)) {
		throw new Error(`malformed truncated-output hash: ${hash.slice(0, 96)}`);
	}
	return path.join(getDataDir(), "truncated", hash);
}

/**
 * Store a trimmed output's full original under its content hash. Idempotent:
 * if the hash is already on disk the write is skipped (the bytes are its
 * name, so what's there is by definition the same content — re-writing could
 * only ever produce identical bytes, and skipping keeps mtime honest for the
 * 30-day prune). Fire-and-forget from the caller's perspective: a failed
 * write costs a recovery link, not a turn, so errors are swallowed here.
 */
export function storeTruncatedOutput(hash: string, original: string): void {
	try {
		const file = truncatedPathFor(hash);
		if (existsSync(file)) return;
		mkdirSync(path.dirname(file), { recursive: true });
		// Write-then-rename so a crash mid-write can never leave a half file
		// sitting at the real name — the hash would then name corrupt bytes.
		const tmp = `${file}.${randomUUID()}.tmp`;
		writeFileSync(tmp, original, "utf-8");
		renameSync(tmp, file);
	} catch {
		// Best-effort by contract (see doc comment). Nothing to log it with
		// reliably at this layer; the marker's 404 is the visible symptom.
	}
	// Age out stale entries on the write path too — throttled internally to
	// once an hour, so a trim-heavy seed doesn't rescan the directory.
	try {
		maybePruneTruncatedOutputs();
	} catch {
		// Same best-effort contract.
	}
}

/** The full original for `hash`, or `null` when it isn't stored — expired by
 * the prune, never written, or a malformed hash (which names no file). */
export function readTruncatedOutput(hash: string): string | null {
	if (!isValidTruncatedHash(hash)) return null;
	try {
		return readFileSync(truncatedPathFor(hash), "utf-8");
	} catch {
		return null;
	}
}

/** Existence check for callers that only need the boolean (issue #274's
 * re-read counter: "a re-`read` of a path whose hash is already stored"). */
export function hasTruncatedOutput(hash: string): boolean {
	return isValidTruncatedHash(hash) && existsSync(truncatedPathFor(hash));
}

/**
 * Delete every stored original older than `maxAgeMs` (measured on the file's
 * mtime — its write time). Returns how many files went. A missing directory
 * is "nothing stored yet", not an error.
 */
export function pruneTruncatedOutputs(
	now: number = Date.now(),
	maxAgeMs: number = TRUNCATED_MAX_AGE_MS,
): number {
	const dir = path.join(getDataDir(), "truncated");
	if (!existsSync(dir)) return 0;
	let pruned = 0;
	for (const name of readdirSync(dir)) {
		// Only content names live here; skip temp leftovers from a crashed
		// write — they carry a `.tmp` suffix and age out identically below.
		const file = path.join(dir, name);
		try {
			if (statSync(file).mtimeMs <= now - maxAgeMs) {
				rmSync(file, { force: true });
				pruned += 1;
			}
		} catch {
			// Raced with another prune/delete — nothing to do for this name.
		}
	}
	return pruned;
}

let lastPruneAt = 0;

/** Prune, but at most once per {@link PRUNE_INTERVAL_MS} — the throttle that
 * lets the write path call this on every store without re-scanning the
 * directory each time. Pass `force` (boot time) to ignore the throttle. */
export function maybePruneTruncatedOutputs(
	now: number = Date.now(),
	force = false,
): void {
	if (!force && now - lastPruneAt < PRUNE_INTERVAL_MS) return;
	lastPruneAt = now;
	pruneTruncatedOutputs(now);
}

/**
 * The one seam between a seed-walk trim and its two side effects (issue
 * #273's disk store, issue #274's counters). Both walk consumers — the
 * cold-start seed and the transcript route — call this from `onTrim` so
 * the ordering stays in one place:
 *
 * - **Reread detection precedes the store.** A dedup trim of a `read`
 *   whose hash is *already* stored is the honest failure mode — the agent
 *   went and re-read a file dilna had truncated. The check must run
 *   before this entry's own original is written, because the entry may
 *   BE that write (identical content, same hash) and would otherwise
 *   always find its own file. Counted once per offending part: the
 *   `truncation_events` unique index collapses repeat walks.
 * - **The store write** lands regardless (a reread's original is already
 *   there — idempotent no-op).
 * - **Trim savings** are recorded only when `countSavings` is set (the
 *   seed): `tokens_saved` is the seed-time estimate — removed chars over
 *   the provider's chars-per-token — of the input tokens that seed didn't
 *   pay. The transcript walk does NOT record savings: rendering a marker
 *   saves nothing; only a request that actually carries the trimmed form
 *   does. Rereads skip the trim event — the same part must not be both a
 *   saving and a re-read cost in one walk.
 */
export function processSeedTrim(
	sessionId: string,
	callId: string,
	trim: TrimmedToolOutput,
	opts: { provider: string; countSavings: boolean },
): void {
	const isReread =
		trim.reason === "dedup" &&
		trim.tool === "read" &&
		hasTruncatedOutput(trim.hash);
	storeTruncatedOutput(trim.hash, trim.original);
	if (isReread) {
		recordTruncationEvent({
			sessionId,
			kind: "reread",
			hash: trim.hash,
			callId,
		});
		return;
	}
	if (opts.countSavings) {
		const savedChars = Math.max(0, trim.originalChars - trim.seeded.length);
		recordTruncationEvent({
			sessionId,
			kind: "trim",
			hash: trim.hash,
			tokensSaved: Math.round(savedChars / charsPerTokenFor(opts.provider)),
		});
	}
}
