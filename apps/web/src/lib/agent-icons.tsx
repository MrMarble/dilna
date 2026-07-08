import { SiClaude } from "@icons-pack/react-simple-icons";
import { Bot } from "lucide-react";
import type { AgentType } from "@/api/client";

/** Brand icon per Agent backend. UI copy only (see agent-labels.ts). Simple
 * Icons has no OpenAI entry, so it falls back to a generic bot icon. */
export function AgentIcon({
	agentType,
	className,
}: {
	agentType: AgentType;
	className?: string;
}) {
	if (agentType === "claude") return <SiClaude className={className} />;
	return <Bot className={className} />;
}
