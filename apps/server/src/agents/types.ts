import type { AgentStreamEvent } from "@dilna/shared";

export type AgentHandle = {
	agentSessionId: string;
	/** Hard kill of the underlying process. Resolves when the process has exited. */
	stop: () => Promise<void>;
	/** True if the underlying process is still alive. */
	isAlive: () => boolean;
};

export type AgentStartOptions = {
	worktreePath: string;
	existingAgentSessionId?: string;
};

export type AgentChatOptions = {
	message: string;
	onEvent: (event: AgentStreamEvent) => void;
	abortSignal?: AbortSignal;
};

export interface Agent {
	start(opts: AgentStartOptions): Promise<AgentHandle>;
	chat(handle: AgentHandle, opts: AgentChatOptions): Promise<void>;
	stop(handle: AgentHandle): Promise<void>;
	isAlive(handle: AgentHandle): boolean;
}

export type AgentFactory = (worktreePath: string) => Agent;

export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
