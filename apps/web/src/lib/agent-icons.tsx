import {
	SiAnthropic,
	SiDeepseek,
	SiMoonshotai,
} from "@icons-pack/react-simple-icons";
import { Bot, Pi as PiIcon } from "lucide-react";
import type { AgentType } from "@/api/client";

/**
 * Simple Icons brand mark per provider id — the ids the server's
 * `PROVIDER_ALLOWLIST` (apps/server/src/agents/providerConfig.ts) uses and
 * `SessionView.provider` carries. Extend by adding one entry here. Simple
 * Icons are monochrome; rendered with their default `currentColor` fill they
 * inherit the surrounding text color, so they track dark/light theme exactly
 * like the lucide glyphs they sit alongside.
 *
 * `zai` is deliberately absent: Simple Icons has no entry for Z.ai (nor its
 * parent brand Zhipu AI), so those Sessions fall through to the per-Agent
 * fallback below. Same for user-defined custom providers, whose ids are
 * arbitrary.
 */
const PROVIDER_ICONS: Record<string, typeof SiAnthropic> = {
	anthropic: SiAnthropic,
	deepseek: SiDeepseek,
	moonshotai: SiMoonshotai,
};

/** Icon for the assistant in a Session: the provider's brand icon when the
 * Session carries a resolved provider (multi-provider support — see
 * `SessionView.provider`), else a per-Agent glyph. `provider` is null/absent
 * on pre-multi-provider Sessions, and unmapped for `zai`/custom providers —
 * both fall back here rather than rendering nothing. Simple Icons has no
 * dedicated entry for pi-ai/pi-agent-core (its Raspberry Pi and Pi-hole
 * entries are unrelated brands), so the "pi" Agent uses lucide's Pi glyph —
 * distinct from the generic bot icon so a pi-backed session doesn't look
 * identical to the openai fallback. */
export function AgentIcon({
	agentType,
	provider,
	className,
}: {
	agentType: AgentType;
	provider?: string | null;
	className?: string;
}) {
	const ProviderIcon = provider ? PROVIDER_ICONS[provider] : undefined;
	if (ProviderIcon) {
		return <ProviderIcon className={className} />;
	}
	if (agentType === "pi") {
		return <PiIcon className={className} />;
	}
	return <Bot className={className} />;
}
