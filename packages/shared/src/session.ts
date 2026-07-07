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

/**
 * Cross-session status broadcast (per ADR-0006/ADR-0008 "Q17" sidebar
 * stream): one subscription per app load, independent of any single
 * session's own SSE stream, so the UI can track Sessions the user isn't
 * currently viewing.
 */
export type SessionListEvent =
	| { type: "session_status"; session: SessionView }
	| { type: "session_deleted"; sessionId: string };
