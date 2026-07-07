import type { AgentType } from "@/api/client";

/** Display names for Agent backends. UI copy only — the domain model refers
 * to these by their AgentType id (see CONTEXT.md's "Agent"). */
export const AGENT_LABELS: Record<AgentType, string> = {
	opencode: "OpenCode",
	claude: "Claude",
	openai: "OpenAI",
};
