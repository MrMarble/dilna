import type { SessionStatus, UsageTotals } from "./events";
import type { AgentType, SessionKind } from "./types";

export type Session = {
	id: string;
	repoId: string;
	worktreePath: string;
	worktreeDirName: string;
	branchName: string;
	agentType: AgentType;
	/** See {@link SessionKind}. Defaults to "session" for every pre-existing
	 * row. */
	kind: SessionKind;
	title: string;
	status: SessionStatus;
	/** Session-lifetime token totals, persisted turn by turn (the agent only
	 * reports per-turn usage, so dilna accumulates it itself — see
	 * SessionManager.accumulateSessionUsage). */
	usage: UsageTotals;
	/** Compaction state (ADR-0023) — internal to the server's agent-seeding
	 * path (SessionManager.startAgent/maybeCompactSession), not surfaced to
	 * the web UI (absent from SessionView). Both null until the Session's
	 * first compaction. */
	compactedSummary: string | null;
	compactedThroughMessageId: string | null;
	/** ADR-0025: the orchestrator Session's own id, when this Session was
	 * created via `dilna_create_session` — null otherwise. Internal to the
	 * server (absent from SessionView), same as the compaction fields above. */
	spawnedBy: string | null;
	createdAt: number;
	lastActiveAt: number;
};

export type SessionView = {
	id: string;
	repoId: string;
	title: string;
	agentType: AgentType;
	kind: SessionKind;
	status: SessionStatus;
	/** See {@link Session.usage}. Seeds the chat header's token badge on
	 * mount, so it doesn't restart from 0 after a reload or session switch. */
	usage: UsageTotals;
	createdAt: number;
	lastActiveAt: number;
};

/** The two plan rate-limit windows dilna's sidebar footer surfaces. The SDK's
 * `SDKRateLimitInfo.rateLimitType` also carries per-model sub-variants
 * (`seven_day_opus`/`seven_day_sonnet`/etc.) and `overage`; those are out of
 * scope for this two-bar UI (see docs/research/claude-agent-sdk-usage-limits.md). */
export type RateLimitWindowKind = "five_hour" | "seven_day";

/**
 * Last-known utilization for one plan rate-limit window, account-wide (not
 * per-Session). Only ever present for claude.ai subscription accounts — the
 * SDK reports plan limits only for those (`rate_limits` is null for
 * API-key/Bedrock/Vertex sessions). Sourced primarily from the SDK's usage
 * pull API after each turn, with the push `rate_limit_event` as a secondary
 * feed when it carries a real number (see `agents/claude.ts`'s
 * `fetchClaudeRateLimits` and sessions/rateLimits.ts), and persisted
 * server-side so it survives restarts.
 */
export type RateLimitWindow = {
	kind: RateLimitWindowKind;
	/** 0-100. */
	utilizationPct: number;
	/** Epoch seconds. Once this has passed, the server omits the window from
	 * `rate_limits` events rather than serving a frozen percentage — see
	 * SessionManager's rateLimits.ts staleness helpers. */
	resetsAt: number;
};

/**
 * Cross-session status broadcast (per ADR-0006/ADR-0008 "Q17" sidebar
 * stream): one subscription per app load, independent of any single
 * session's own SSE stream, so the UI can track Sessions the user isn't
 * currently viewing.
 */
export type SessionListEvent =
	| { type: "session_status"; session: SessionView }
	| { type: "session_deleted"; sessionId: string }
	| {
			/**
			 * Account-wide plan rate-limit utilization, pushed whenever a live
			 * Session's agent process reports a change — either the SDK's
			 * push `rate_limit_event` or the post-turn usage pull (see
			 * `SessionManager.applyRateLimitWindows`). Deliberately not part of
			 * the per-session `AgentStreamEvent` union (ADR-0006): rate limits
			 * are account-wide, not scoped to the Session that happened to
			 * report them, so contorting the per-session event union to carry
			 * them would be dishonest to what that union documents.
			 */
			type: "rate_limits";
			windows: RateLimitWindow[];
	  };
