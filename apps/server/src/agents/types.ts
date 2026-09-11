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
	/** Image attachments to send alongside `message`, already read off disk
	 * and base64-encoded (issue #53). Inline rather than by path because this
	 * is the only channel through which a Provider can actually *see* a
	 * picture; non-image attachments take the other channel — their path is
	 * named in `message` and the Agent reads them with its own tools. */
	images?: { data: string; mimeType: string }[];
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

/**
 * Hard ceiling on a single turn. The underlying SDK's streaming-input query
 * loop has no timeout of its own — if the agent backend stalls (flaky
 * network egress, a hung upstream API call) the loop just never yields
 * another message, and nothing else in dilna ever notices: no `result`, no
 * crash. Without this, `chatInProgress` stays `true` forever, the session
 * shows no error and no recovery affordance, and every future send is
 * rejected with "session already has a chat in progress" until something
 * external (a pod restart) kills the process. SessionManager races this
 * against the turn and treats a timeout as a crash — same recovery path,
 * same client-visible signal, but self-healing instead of requiring manual
 * intervention every time.
 */
export const TURN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Bound on the `stopping` status (ADR-0016 §3): once a Stop request aborts
 * the in-flight turn, the process is expected to land `idle` quickly. If it
 * hasn't within this window the manager treats it as wedged, hard-kills the
 * process, and routes `turn_failed(turn_timeout)` → `crashed` — the same
 * escalation the normal turn-timeout path already uses, just on a much
 * shorter clock since the agent has already been asked to stop.
 */
export const STOP_TIMEOUT_MS = 10 * 1000;
