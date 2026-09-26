import type {
	AgentType,
	Session,
	SessionKind,
	SessionView,
} from "@dilna/shared";
import type { sessions as sessionsTable } from "../db/schema";
import type { SessionCompaction } from "./context";

/**
 * Row/domain/view mapping for `sessions`, extracted from `SessionManager`
 * (issue #149). Pure functions over shapes — no DB access, no state — so
 * both the manager and its collaborators can convert without importing each
 * other.
 */

export function rowToSession(row: typeof sessionsTable.$inferSelect): Session {
	return {
		id: row.id,
		repoId: row.repoId,
		worktreePath: row.worktreePath,
		worktreeDirName: row.worktreeDirName,
		branchName: row.branchName,
		agentType: row.agentType as AgentType,
		kind: row.kind as SessionKind,
		title: row.title,
		status: row.status as Session["status"],
		usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens },
		compactedSummary: row.compactedSummary,
		compactedThroughMessageId: row.compactedThroughMessageId,
		spawnedBy: row.spawnedBy,
		comparisonGroupId: row.comparisonGroupId,
		provider: row.provider,
		model: row.model,
		createdAt: row.createdAt,
		lastActiveAt: row.lastActiveAt,
	};
}

export function toView(s: Session): SessionView {
	return {
		id: s.id,
		repoId: s.repoId,
		title: s.title,
		agentType: s.agentType,
		kind: s.kind,
		provider: s.provider,
		model: s.model,
		comparisonGroupId: s.comparisonGroupId ?? null,
		status: s.status,
		usage: s.usage,
		createdAt: s.createdAt,
		lastActiveAt: s.lastActiveAt,
	};
}

/**
 * The framework-generated placeholder every ordinary (non-orchestrator)
 * Session is created with, before its first turn's title derivation runs
 * (see `SessionManager.maybeDeriveTitle`). `create()` and the first-turn
 * guard share this so they can stay in lockstep about what "still needs a
 * derived title" means.
 */
export function defaultSessionTitle(id: string): string {
	return `Session ${id.slice(0, 4)}`;
}

/** Longest fallback title, chosen so a truncated prompt still reads as a
 * phrase rather than cutting mid-word without warning. */
const FALLBACK_TITLE_MAX_CHARS = 48;

/**
 * Deterministic Session title derived straight from the first prompt — the
 * fallback when the model call behind `generateSessionTitle` yields nothing
 * (provider rejects the tiny no-tools request, errors, or replies empty).
 * Title derivation must not depend on the provider behaving: without this,
 * a provider that won't answer the title call leaves every Session on the
 * generic placeholder forever.
 *
 * Takes the first non-empty line (where `describeAttachmentsForTitle` puts
 * the user's own text), collapses whitespace, and truncates at a word
 * boundary. An attachment-only first turn titles itself after the first
 * attachment's filename. Returns `null` when there is nothing at all to
 * derive from — the caller keeps the placeholder, which a later turn's
 * derivation can still replace.
 */
export function fallbackSessionTitle(prompt: string): string | null {
	const line = prompt
		.split("\n")
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	if (!line) return null;
	// `describeAttachmentsForTitle` wraps filenames in `[attached: …]` when
	// the turn carried no text — keep the filename, drop the marker.
	const bare = line
		.replace(/^\[attached:\s*(.*?)\]$/, "$1")
		.replace(/^[-*+]\s+/, "");
	if (bare.length <= FALLBACK_TITLE_MAX_CHARS) return bare;
	const cut = bare.slice(0, FALLBACK_TITLE_MAX_CHARS);
	const lastSpace = cut.lastIndexOf(" ");
	const truncated =
		lastSpace > FALLBACK_TITLE_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
	return `${truncated.trimEnd()}…`;
}

/** `Session`'s two compaction columns (ADR-0023), reshaped into
 * `context.ts`'s `SessionCompaction` — the one place that pairing happens, so every caller
 * (the turn-end check, the idle-session REST estimate) treats "only one of
 * the two columns is set" the same way (falls back to `null`, i.e. no
 * compaction — shouldn't happen since both are always written together, but
 * there's no DB constraint enforcing that). */
export function sessionCompactionOf(session: Session): SessionCompaction {
	return session.compactedSummary && session.compactedThroughMessageId
		? {
				summary: session.compactedSummary,
				throughMessageId: session.compactedThroughMessageId,
			}
		: null;
}
