import type { ContextUsageEstimate, Message } from "@dilna/shared";
import {
	type AgentMessage,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	shouldCompact,
} from "@earendil-works/pi-agent-core";
import {
	dilnaMessagesToInitialState,
	resolveSummarizationModel,
	summarizeMessages,
} from "../agents/pi";

/**
 * Session context/compaction policy (ADR-0023) and the deleted-Session
 * archive summary (ADR-0024), extracted from `agents/pi.ts` (issue #175).
 *
 * None of this is adapter mechanics. A cut point, a reserve-token budget,
 * "summarize everything before the last N tokens of turns", "a second
 * compaction updates the previous summary rather than re-deriving it" —
 * those are Session-lifetime policies whose inputs are a Session's persisted
 * history plus its stored compaction, and whose outputs are a new compaction
 * row and a `context_usage` broadcast. All Session concepts; nothing about
 * them is specific to `pi-agent-core`.
 *
 * Only two things here genuinely belong to the Agent backend, and both are
 * called through narrow entry points `agents/pi.ts` exports rather than
 * being reimplemented: resolving a catalog `Model` from a provider/model
 * pair ({@link resolveSummarizationModel}) and running the summarization
 * round-trip ({@link summarizeMessages}). Transcript shape conversion
 * (`dilnaMessagesToInitialState`) stays adapter-side too — this module only
 * calls it, since "how many tokens does this history occupy" can't be
 * answered without knowing what the backend will actually be sent.
 *
 * The dependency direction is now one-way: `sessions/` imports `agents/`,
 * never the reverse. Concretely, `checkSessionContext` no longer takes a
 * `PiHandle` and no longer mutates a live `Agent`'s transcript in place — it
 * *returns* the rebuilt context as `SessionContextCheck.newContext` and
 * leaves applying it to `SessionManager`, which owns the live handle. That
 * also makes the whole policy testable with plain `Message[]` values and no
 * `PiHandle` stub.
 *
 * Matches ADR-0027's convention: free functions, no instance state,
 * alongside `archive.ts`/`usageStats.ts`/`diff.ts`.
 */

/**
 * Prefix wrapped around a compaction summary before it's seeded as the
 * leading message of a Session's context — framed as prior context rather
 * than a fresh instruction, since it stands in for everything up to
 * `compactedThroughMessageId` rather than something the user just said.
 */
const COMPACTION_SUMMARY_PREFACE =
	"The following is a summary of earlier conversation history that was " +
	"compacted to stay within the model's context window. Treat it as prior " +
	"context, not a new instruction:\n\n";

/** A Session's persisted compaction state ({@link sessions.compactedSummary}/
 * `.compactedThroughMessageId}), or `null` for a Session never compacted. */
export type SessionCompaction = {
	summary: string;
	throughMessageId: string;
} | null;

/**
 * Walk dilna's own message rows backward from the end, accumulating each
 * one's estimated token size (its own `dilnaMessagesToInitialState`
 * expansion, summed via pi-agent-core's `estimateTokens`) until
 * `keepRecentTokens` is reached. dilna's rows are already turn-granular —
 * one row per user/assistant turn, with any tool calls merged in (the
 * inverse of pi's per-tool-call transcript entries, see
 * `dilnaMessagesToInitialState`'s doc comment) — so this doubles as
 * pi-agent-core's own `findCutPoint` "snap to a turn boundary" requirement,
 * without needing pi's `Entry[]` session-log wrapper this function's inputs
 * never had in the first place.
 *
 * Returns the index of the first message to keep verbatim; everything
 * before it is the summarization candidate.
 */
export function pickCutPoint(
	history: Message[],
	keepRecentTokens: number,
): number {
	let kept = 0;
	let index = history.length;
	for (let i = history.length - 1; i >= 0; i--) {
		const size = dilnaMessagesToInitialState([history[i] as Message]).reduce(
			(sum, m) => sum + estimateTokens(m),
			0,
		);
		if (kept > 0 && kept + size > keepRecentTokens) break;
		kept += size;
		index = i;
	}
	return index;
}

/**
 * Build a fresh `Agent`'s `initialState.messages` from dilna's own message
 * history, folding in a stored compaction when one exists — shared by every
 * cold start (`SessionManager.startAgent`) and by
 * {@link checkSessionContext}'s own post-compaction rebuild, so both paths
 * produce identical context for the same `(history, compaction)` pair.
 */
export function buildInitialMessages(
	history: Message[],
	compaction: SessionCompaction,
): AgentMessage[] {
	if (!compaction) return dilnaMessagesToInitialState(history);

	const cutIndex = history.findIndex(
		(m) => m.id === compaction.throughMessageId,
	);
	// A stale/missing pointer (shouldn't happen — messages are never deleted
	// outside of session delete) degrades to the full raw history rather than
	// silently dropping context.
	const tail = cutIndex === -1 ? history : history.slice(cutIndex + 1);

	const summaryMessage: AgentMessage = {
		role: "user",
		content: COMPACTION_SUMMARY_PREFACE + compaction.summary,
		timestamp: Date.now(),
	};
	return [summaryMessage, ...dilnaMessagesToInitialState(tail)];
}

/**
 * Estimate against `contextWindow`, folding in `compaction` the same way
 * {@link buildInitialMessages} would seed a fresh `Agent` — so the number
 * reported always matches what the model actually sees, not dilna's raw
 * (never-shrinking) `messages` history.
 */
function estimateFor(
	contextWindow: number,
	history: Message[],
	compaction: SessionCompaction,
): ContextUsageEstimate {
	return {
		tokens: estimateContextTokens(buildInitialMessages(history, compaction))
			.tokens,
		contextWindow,
		reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
	};
}

/**
 * Same estimate as {@link checkSessionContext} computes, for a Session with
 * no live `Agent` (idle, never started, or respawned since) — used by
 * `GET /api/sessions/:id` so a page load/session switch shows the last-known
 * occupancy immediately, instead of the sidebar meter staying blank until
 * the Session's next turn (see `context_usage`'s doc comment in
 * packages/shared/src/events.ts). `provider`/`modelId` should be the
 * Session's live `PiHandle`'s captured values when one exists, or the
 * currently-effective config otherwise (the same resolution `startAgent`
 * would use if the Session resumed right now — see `PiHandle`'s doc comment
 * on why this can drift from what a still-running Session actually used).
 */
export function estimateSessionContext(
	provider: string,
	modelId: string,
	history: Message[],
	compaction: SessionCompaction,
): ContextUsageEstimate | null {
	const model = resolveSummarizationModel(provider, modelId);
	return model ? estimateFor(model.contextWindow, history, compaction) : null;
}

export type SessionContextCheck = {
	/** `null` only when the Session's provider/model is no longer in dilna's
	 * catalog (see `resolveSummarizationModel`) — nothing to report or
	 * compact against. */
	estimate: ContextUsageEstimate | null;
	/** The new compaction to persist onto the `sessions` row, or `null` when
	 * compaction wasn't due (or its summarization call failed). */
	compaction: SessionCompaction;
	/** The rebuilt context the live `Agent` should switch to, set exactly
	 * when `compaction` is — so the *current* Session's context shrinks
	 * immediately rather than only at its next cold start. Returned rather
	 * than written straight into `handle.agent.state.messages` so this module
	 * never reaches into a live Agent; `SessionManager` owns the handle and
	 * applies it (it has to touch the handle anyway, to reset its
	 * `persistedCount` high-water mark against the replacement array). */
	newContext: AgentMessage[] | null;
};

/**
 * Run after a turn's messages are already durably persisted
 * (`SessionManager.persistMessagesFromAgent`) — estimates how much of the
 * context window is occupied (against `priorCompaction`, the Session's
 * already-stored compaction if any — estimating against raw history instead
 * would ignore that the live `Agent`'s actual context is already the
 * smaller, summarized one, and re-trigger compaction on essentially every
 * subsequent turn) and, once that crosses the budget threshold, summarizes
 * everything since `priorCompaction`'s cutoff but the most recent
 * `keepRecentTokens` worth of turns.
 *
 * A second (or later) compaction passes `priorCompaction.summary` to
 * `summarizeMessages` as its previous summary — an *update* to the existing
 * summary covering only what's newly being folded in, not a from-scratch
 * re-summarization of everything before the new cutoff.
 *
 * `provider`/`modelId` are the ones the Session's live `Agent` was actually
 * constructed with (`PiHandle.provider`/`.model`), not whatever is currently
 * effective — the configured provider/model is web-configurable and can
 * change under a long-lived Session.
 *
 * Always returns an `estimate` (for the caller to broadcast as
 * `context_usage`, ADR-0023's addendum on UI visibility). `compaction` and
 * `newContext` are both `null` when compaction wasn't due, or when the
 * summarization call failed (not fatal to the turn that just completed;
 * simply retried at the next turn's check).
 */
export async function checkSessionContext(
	provider: string,
	modelId: string,
	history: Message[],
	priorCompaction: SessionCompaction,
): Promise<SessionContextCheck> {
	const model = resolveSummarizationModel(provider, modelId);
	if (!model) return { estimate: null, compaction: null, newContext: null };

	const estimate = estimateFor(model.contextWindow, history, priorCompaction);
	const notDue: SessionContextCheck = {
		estimate,
		compaction: null,
		newContext: null,
	};
	if (
		!shouldCompact(
			estimate.tokens,
			estimate.contextWindow,
			DEFAULT_COMPACTION_SETTINGS,
		)
	) {
		return notDue;
	}

	const tailHistory = history.slice(historyCutFrom(history, priorCompaction));

	const cutIndexInTail = pickCutPoint(
		tailHistory,
		DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
	);
	if (cutIndexInTail <= 0) return notDue;

	const newlySummarized = tailHistory.slice(0, cutIndexInTail);
	const summary = await summarizeMessages({
		model,
		messages: dilnaMessagesToInitialState(newlySummarized),
		reserveTokens: estimate.reserveTokens,
		previousSummary: priorCompaction?.summary,
	});
	// `summarizeMessages` already logged the concrete provider error; there's
	// nothing to add here beyond "so no compaction happened this turn", which
	// the next turn's check retries anyway.
	if (!summary) return notDue;

	const compaction: SessionCompaction = {
		summary,
		// Safe: `cutIndexInTail > 0` was checked above, so `newlySummarized` is
		// non-empty.
		throughMessageId: (newlySummarized.at(-1) as Message).id,
	};
	const newContext = buildInitialMessages(history, compaction);

	// Report the *post*-compaction occupancy, not the stale pre-compaction
	// number that triggered this — the whole point of compacting was to
	// bring it back down.
	return {
		estimate: {
			tokens: estimateContextTokens(newContext).tokens,
			contextWindow: estimate.contextWindow,
			reserveTokens: estimate.reserveTokens,
		},
		compaction,
		newContext,
	};
}

/**
 * Final summary for a Session about to be deleted (ADR-0024) — reuses the
 * same summarization call {@link checkSessionContext} makes, but produces
 * one summary covering the *entire* Session (no retained tail: there's no
 * live `Agent` left to keep serving one to). If the Session already has a
 * stored compaction, only the tail after its cutoff needs summarizing,
 * passed as the previous summary (an update, not a from-scratch
 * re-summarization) — or, if nothing happened since that cutoff, the
 * existing summary is returned verbatim with no LLM call at all. Returns
 * `null` when there's nothing to archive (`history` empty) or the
 * provider/model can no longer be resolved; the caller treats both as "skip
 * archiving, delete anyway."
 */
export async function summarizeSessionForArchive(
	provider: string,
	modelId: string,
	history: Message[],
	priorCompaction: SessionCompaction,
): Promise<string | null> {
	if (history.length === 0) return null;
	const model = resolveSummarizationModel(provider, modelId);
	if (!model) return null;

	const tailHistory = history.slice(historyCutFrom(history, priorCompaction));
	if (tailHistory.length === 0) return priorCompaction?.summary ?? null;

	const summary = await summarizeMessages({
		model,
		messages: dilnaMessagesToInitialState(tailHistory),
		reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
		previousSummary: priorCompaction?.summary,
	});
	// Failure already logged by `summarizeMessages` (see the compaction path).
	// `null` here is the caller's signal to delete the Session unarchived.
	return summary;
}

/**
 * Index of the first message not already covered by `priorCompaction` — i.e.
 * where the next summarization has to start from. `0` (summarize everything)
 * both for a never-compacted Session and for a stale pointer no longer in
 * `history`, since `findIndex` returning -1 lands on the same `max(0, …)`.
 */
function historyCutFrom(
	history: Message[],
	priorCompaction: SessionCompaction,
): number {
	if (!priorCompaction) return 0;
	return Math.max(
		0,
		history.findIndex((m) => m.id === priorCompaction.throughMessageId) + 1,
	);
}
