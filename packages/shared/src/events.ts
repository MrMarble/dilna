import type { ChangedFile } from "./diff";
import type { Message } from "./messages";

export type AgentStreamEvent =
	| { type: "session_status"; status: SessionStatus }
	| { type: "changed_files"; files: ChangedFile[] }
	| {
			/** Broadcast at accept time (ADR-0016 §6), carrying the same
			 * persisted row the 202 response echoes back to the sender — every
			 * subscriber (sender and non-sender tabs alike) converges on one
			 * message id for the user's turn, instead of each tab reconciling
			 * its own optimistic bubble independently. */
			type: "user_message";
			message: Message;
	  }
	| { type: "message_start"; messageId: string; role: "user" | "assistant" }
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
			tool: string;
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
			runningTools: { callId: string; tool: string; startedAt: number }[];
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
	  };

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
