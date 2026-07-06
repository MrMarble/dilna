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
	status: SessionStatus;
	createdAt: number;
	lastActiveAt: number;
};
