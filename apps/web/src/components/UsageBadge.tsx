import { useSessionUsage } from "@/hooks/useSessionUsage";
import { formatTokenCount } from "@/lib/tokens";

type Props = {
	sessionId: string;
};

/**
 * Tokens-only usage badge for the chat header (issue #10 — no cost). Hidden
 * on mobile (issue #12's header decluttering) in favor of a plain-text
 * token fact alongside the rest of "Current session" in the Changed-files
 * sheet — see `ContextPanel`'s `SessionSection`.
 */
export function UsageBadge({ sessionId }: Props) {
	const total = useSessionUsage(sessionId);
	const totalTokens = total.inputTokens + total.outputTokens;

	return (
		<span
			className="hidden rounded-full border border-border px-2 py-0.5 text-xs tabular-nums text-muted-foreground md:inline"
			title={`Input ${total.inputTokens.toLocaleString()} · Output ${total.outputTokens.toLocaleString()}`}
		>
			Tokens · {formatTokenCount(totalTokens)}
		</span>
	);
}
