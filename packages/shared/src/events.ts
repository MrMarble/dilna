import type { ChangedFile } from "./diff";

export type AgentStreamEvent =
	| { type: "session_status"; status: SessionStatus }
	| { type: "changed_files"; files: ChangedFile[] }
	| { type: "message_start"; messageId: string; role: "user" | "assistant" }
	| { type: "token"; messageId: string; chunk: string }
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
	| { type: "error"; message: string; stderrTail?: string[] }
	| { type: "agent_crashed"; exitCode: number; stderrTail: string[] }
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

/** Tokens-only usage totals (no cost) — see docs/research/claude-agent-sdk-usage-limits.md. */
export type UsageTotals = {
	inputTokens: number;
	outputTokens: number;
};
