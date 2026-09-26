import type { Artefact } from "./artefact";
import type { ChangedFile } from "./diff";
import type { Attachment, Message, QueuedMessage } from "./messages";
import type { WireToolName } from "./tools";

export type AgentStreamEvent =
	| { type: "session_status"; status: SessionStatus }
	| { type: "changed_files"; files: ChangedFile[] }
	| {
			/** An Agent published an Artefact this turn (issue #194, ADR-0032).
			 * Carries the whole record, not an id, so the context panel appends
			 * without a refetch — the same reason `changed_files` carries files.
			 *
			 * Unlike `changed_files` this is *incremental*, not a snapshot: an
			 * Artefact is immutable once published, so there is no recomputed
			 * list to re-send. Consumers append. */
			type: "artefact_published";
			artefact: Artefact;
	  }
	| {
			/** Broadcast at accept time (ADR-0016 §6), carrying the same
			 * persisted row the 202 response echoes back to the sender — every
			 * subscriber (sender and non-sender tabs alike) converges on one
			 * message id for the user's turn, instead of each tab reconciling
			 * its own optimistic bubble independently. */
			type: "user_message";
			message: Message;
	  }
	| {
			/** The Session's send queue changed (ADR-0033) — an entry was added,
			 * removed, or the whole queue was drained into a turn. Level-based
			 * like `changed_files`: carries the entire queue, so every subscriber
			 * converges without diffing, and a client that missed one is healed
			 * by the next (or by the REST refetch its resync already does). */
			type: "queue_update";
			queued: QueuedMessage[];
	  }
	| {
			/** The Agent sent an image into the chat (issue #222, ADR-0038).
			 *
			 * Unlike `artefact_published`, which updates a side panel, this is a
			 * *message content* event: {@link applyEventToParts} folds it into the
			 * in-flight assistant message's parts, so the picture lands between the
			 * prose before it and the prose after it. It exists because
			 * pi-agent-core has no content block that carries an image out of an
			 * assistant turn — the tool mints the part out-of-band.
			 *
			 * Carries the whole record for the same reason the others do: the
			 * renderer needs `sessionId`/`id` to build the bytes URL and
			 * `filename`/`kind` to render, and a refetch mid-turn would be a
			 * round trip for data the server already has in hand. */
			type: "image_sent";
			messageId: string;
			attachment: Attachment;
	  }
	| {
			type: "message_start";
			messageId: string;
			role: "user" | "assistant";
			/** True on a *re-narration* of a message the consumer may already hold —
			 * ADR-0014's mid-turn snapshot replay (see `liveTurnReplayEvents`),
			 * as opposed to the real start of a message nobody has seen before.
			 *
			 * A consumer that folds events into accumulated parts (`applyEventToParts`)
			 * must **discard** whatever it already has for `messageId` and rebuild
			 * from the replay's own events. Folding a replay into an
			 * already-populated message appends a second copy of every text chunk
			 * and every tool call, because `tool_call_start` appends and `token`
			 * concatenates — the client is then only corrected when the turn ends
			 * and the authoritative rows replace the live overlay (issue #244).
			 *
			 * Optional and additive: absent means "an ordinary start", and a
			 * consumer that ignores it entirely behaves as it did before this
			 * existed. */
			replay?: boolean;
	  }
	| { type: "token"; messageId: string; chunk: string }
	| {
			/** Mirrors `token`'s shape, fed by `thinking_delta` frames (ADR-0016
			 * §5). Invariant: `token` chunks are exactly what persists; `thinking`
			 * chunks are exactly what doesn't — discarded client-side at this
			 * message's `message_end`. */
			type: "thinking";
			messageId: string;
			chunk: string;
	  }
	| {
			type: "tool_call_start";
			messageId: string;
			callId: string;
			/** dilna's own tool vocabulary, not the provider's — narrowed to the
			 * shared union so the web's exhaustive `Record` over it fails to compile
			 * when a tool is added server-side. {@link WireToolName} still admits a
			 * name this build doesn't know (an MCP tool, a newer server), which the
			 * renderer falls back on rather than dropping. */
			tool: WireToolName;
			input: unknown;
	  }
	| {
			type: "tool_call_end";
			messageId: string;
			callId: string;
			output: unknown;
			error?: string;
	  }
	| { type: "message_end"; messageId: string }
	| {
			/** The one failure event on the wire (ADR-0016 §2), replacing the
			 * former `error`/`agent_crashed` pair. Every accepted send ends in
			 * exactly one terminal status; on failure, exactly one `turn_failed`
			 * precedes it. `class` decides the terminal status the manager
			 * transitions to next: `spawn_failure`/`agent_crash`/`turn_timeout`
			 * (no usable agent process remains) → `crashed`;
			 * `turn_error`/`persistence_failure` (the process is alive and
			 * reusable) → `idle`. */
			type: "turn_failed";
			class:
				| "spawn_failure"
				| "agent_crash"
				| "turn_timeout"
				| "turn_error"
				| "persistence_failure";
			message: string;
			detail?: { exitCode?: number; stderrTail?: string[] };
	  }
	| {
			/** Transient, non-persisted line for a degraded-but-not-failed
			 * outcome — e.g. an unresumable Claude session silently starting
			 * fresh (ADR-0016 §2). Rendered as an unobtrusive inline notice, not
			 * an error. */
			type: "notice";
			message: string;
	  }
	| {
			/** Level-based coalesced snapshot of current turn activity
			 * (ADR-0016 §5), extending the status contract's level philosophy:
			 * re-emitted only on discrete changes, valid only inside a turn
			 * (never after the terminal status — the client clears its local
			 * copy on any terminal instead of waiting for an explicit clear),
			 * and present in the opening subscribe-snapshot only mid-turn. */
			type: "turn_activity";
			phase: {
				kind: "requesting" | "compacting" | "retrying";
				attempt?: number;
				maxRetries?: number;
			} | null;
			runningTools: {
				callId: string;
				tool: WireToolName;
				startedAt: number;
			}[];
			tasks: {
				taskId: string;
				description: string;
				lastTool: string;
				toolUses: number;
				startedAt: number;
				/** The spawning Task tool_call's callId, so the client can anchor
				 * this task's activity line under that tool call row. */
				toolUseId?: string;
			}[];
			/** Redacted-phase counter — present only while no `thinking` chunks
			 * are arriving for the current message. */
			thinkingTokens?: number;
			/** Client clock-skew correction for the `startedAt` fields above. */
			serverTime: number;
	  }
	| {
			/** Directive: re-run the standard on-open routine (reset live-turn
			 * state → refetch history → apply the opening snapshot — ADR-0016
			 * §4). Idempotent. Sole producer today is refusal-fallback
			 * retraction. */
			type: "resync";
	  }
	| {
			type: "usage_update";
			messageId: string;
			/** This API call's token delta — per-message usage isn't cumulative
			 * across the multiple API calls a turn can span, so consumers sum
			 * these across a turn. */
			usage: UsageTotals;
			/** Present only on the turn-end reconciling event: the session's
			 * lifetime total to snap accumulated live totals to. The adapter
			 * emits the turn's own usage here (the SDK reports per-turn, not
			 * session-cumulative — verified empirically); the server folds it
			 * into the DB-persisted session total and rewrites this field to
			 * that total before broadcasting, so it always matches what
			 * `GET /api/sessions/:id` serves — see
			 * SessionManager.accumulateSessionUsage. */
			cumulative?: UsageTotals;
	  }
	| ({
			/** Live estimate of how much of the Session's context window is
			 * occupied, broadcast after every turn (ADR-0023) so the UI can show
			 * proximity to compaction — only ever emitted for ordinary Sessions,
			 * never orchestrator ones. `GET /api/sessions/:id`'s `contextUsage`
			 * field seeds the same shape for a page load/session switch, so
			 * unlike `turn_activity` this isn't blank until the next turn. */
			type: "context_usage";
	  } & ContextUsageEstimate);

export type SessionStatus =
	| "idle"
	| "starting"
	| "working"
	| "stopping"
	| "crashed";

/**
 * Per-turn usage totals. `inputTokens`/`outputTokens` are always populated
 * (the original tokens-only contract — see
 * docs/research/claude-agent-sdk-usage-limits.md — still relied on by the
 * live session badge/`Session.usage`). The rest are optional: populated by
 * the pi adapter (`agents/pi.ts`'s `extractUsageTotals`) from pi-ai's richer
 * `Usage` shape, but only consumed today by `usage_events`-backed
 * aggregation (`sessions/usageStats.ts`) — not persisted onto the
 * session-lifetime `sessions.inputTokens`/`outputTokens` columns.
 */
export type UsageTotals = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	costUsd?: number;
};

/**
 * How much of a Session's context window is currently occupied (ADR-0023's
 * addendum) — the payload of the `context_usage` event, also served by
 * `GET /api/sessions/:id` (`OneResponse.contextUsage`) so a page load or
 * session switch doesn't have to wait for the next turn to know where a
 * Session stands.
 */
export type ContextUsageEstimate = {
	/** Estimated tokens the Session's context currently occupies — the
	 * headline figure the meter shows. `usageTokens + trailingTokens` when a
	 * provider report is in reach, else the pure `chars/4` estimate. */
	tokens: number;
	/** Tokens the provider itself reported for the most recent assistant
	 * round in the measured history (`input + output + cacheRead +
	 * cacheWrite`) — the ground-truth portion of `tokens`. 0 when no round
	 * carries a usable report. */
	usageTokens: number;
	/** Estimated tokens for everything *after* that last reported round — a
	 * `chars/4` heuristic, the error-prone part of `tokens`. 0 when the
	 * history ends on the reported round itself. */
	trailingTokens: number;
	/** The resolved model's context window — fixed for this Session's live
	 * Agent (see `PiHandle`'s doc comment on why it can't just be read from
	 * the currently-configured provider/model instead). */
	contextWindow: number;
	/** Tokens reserved for compaction's own summarization call
	 * (`DEFAULT_COMPACTION_SETTINGS.reserveTokens`) — compaction fires once
	 * `tokens` crosses `contextWindow - reserveTokens`. */
	reserveTokens: number;
	/** Whether `tokens` is grounded in a provider report or is entirely the
	 * `chars/4` estimate (issue #268). `"provider"` once the measured
	 * history contains an assistant round carrying a usable usage block;
	 * `"estimated"` when it doesn't — today the cold-start case, where
	 * dilna re-seeds from its own rows and none carries real usage, so the
	 * number a page load shows is a heuristic. Renderers must say which it
	 * is rather than presenting both as ground truth. */
	source: "provider" | "estimated";
};
