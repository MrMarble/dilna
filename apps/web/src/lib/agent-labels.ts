import type { AgentType } from "@/api/client";

/** Display names for Agent backends. UI copy only — the domain model refers
 * to these by their AgentType id (see CONTEXT.md's "Agent"). */
export const AGENT_LABELS: Record<AgentType, string> = {
	pi: "pi",
	openai: "OpenAI",
};

/**
 * Look up an Agent backend's display label, falling back to the raw stored
 * value for one this build's `AgentType` union no longer knows about — e.g.
 * a pre-pi-migration session whose `agent_type = 'claude'` row survived the
 * schema migration untouched (SQLite has no CHECK constraint on the column;
 * "claude never existed" per the migration's own framing means dispatch
 * rejects it, not that old rows disappear). Without this, indexing
 * `AGENT_LABELS` directly with an unrecognized value renders the literal
 * string "undefined" instead of just showing what's actually stored.
 */
export function agentLabel(agentType: string): string {
	return (AGENT_LABELS as Record<string, string>)[agentType] ?? agentType;
}

/**
 * The name a chat row/header should show for the assistant in a Session.
 * Multi-provider (see the Settings view) pins each Session to a concrete
 * model, so its label is that model rather than the generic agent name —
 * "claude-opus-4-5" instead of "pi". Falls back to the agent label (the
 * historical "pi" name) only when the Session has no model snapshot yet
 * (pre-migration, or configured before a model was resolvable).
 */
export function assistantDisplayName(
	model: string | null | undefined,
	agentType: string,
): string {
	return model ?? agentLabel(agentType);
}
