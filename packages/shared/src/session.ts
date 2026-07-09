import type { SessionStatus } from "./events";
import type { AgentType } from "./types";

export type Session = {
	id: string;
	repoId: string;
	worktreePath: string;
	worktreeDirName: string;
	branchName: string;
	agentType: AgentType;
	agentSessionId: string | null;
	title: string;
	status: SessionStatus;
	createdAt: number;
	lastActiveAt: number;
};

export type SessionView = {
	id: string;
	repoId: string;
	title: string;
	agentType: AgentType;
	status: SessionStatus;
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
 * per-Session). Only ever present for claude.ai OAuth-subscription accounts
 * — `apiKeySource !== 'oauth'` sessions never produce these (see ADR on
 * `SDKRateLimitEvent` in the research doc).
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
			 * Session's agent process reports a change (see
			 * `agents/claude.ts`'s `onRateLimit` and
			 * `SessionManager.handleRateLimitEvent`). Deliberately not part of
			 * the per-session `AgentStreamEvent` union (ADR-0006): rate limits
			 * are account-wide, not scoped to the Session that happened to
			 * report them, so contorting the per-session event union to carry
			 * them would be dishonest to what that union documents.
			 */
			type: "rate_limits";
			windows: RateLimitWindow[];
	  };
