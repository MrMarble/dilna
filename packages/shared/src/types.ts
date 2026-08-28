export type AgentType = "pi" | "openai";

export const DEFAULT_AGENT_TYPE: AgentType = "pi";

/**
 * "session" is an ordinary Worktree-bound Session. "orchestrator" is a
 * global, Worktree-less-in-effect Session (its Worktree is bound to a
 * reserved, hidden meta-repo — see ADR-0021) whose Agent is wired with
 * dilna-internals tools instead of filesystem/bash tools, for fanning work
 * out into ordinary Sessions.
 */
export type SessionKind = "session" | "orchestrator";

export const DEFAULT_SESSION_KIND: SessionKind = "session";
