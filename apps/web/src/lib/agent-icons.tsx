import { Bot, Pi as PiIcon } from "lucide-react";
import type { AgentType } from "@/api/client";

/** Brand icon per Agent backend. UI copy only (see agent-labels.ts). Simple
 * Icons has no dedicated entry for pi-ai/pi-agent-core (its Raspberry Pi and
 * Pi-hole entries are unrelated brands), so the "pi" Agent uses lucide's Pi
 * glyph instead — distinct from the generic bot icon so a pi-backed session
 * doesn't look identical to the openai fallback. Simple Icons also has no
 * OpenAI entry, so that case falls back to the generic bot icon. */
export function AgentIcon({
	agentType,
	className,
}: {
	agentType: AgentType;
	className?: string;
}) {
	if (agentType === "pi") {
		return <PiIcon className={className} />;
	}
	return <Bot className={className} />;
}
