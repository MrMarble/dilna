import type { MessagePart } from "@dilna/shared";
import { getToolMeta } from "@/lib/tool-meta";

/**
 * Serializes a rendered message back to the markdown source it came from.
 *
 * Selecting the DOM and hitting ⌘C loses exactly the structure that made the
 * message readable — ordered-list numbers and bullets live in CSS `::marker`
 * pseudo-elements (never part of a selection) and fenced blocks flatten into
 * prose with no fences. Text parts are stored as the agent's own markdown, so
 * copying that verbatim round-trips perfectly into any other markdown surface.
 *
 * Tool calls have no markdown source — they're a UI affordance over the
 * structured `tool_call` part — so they're rendered as the same one-line
 * summary the collapsed UI shows, in italics, to keep the transcript readable
 * without dumping raw tool JSON. Pass `includeToolCalls: false` for text only.
 */
export function partsToMarkdown(
	parts: MessagePart[],
	{ includeToolCalls = true }: { includeToolCalls?: boolean } = {},
): string {
	const chunks: string[] = [];
	for (const part of parts) {
		if (part.type === "text") {
			const text = part.text.trim();
			if (text) chunks.push(text);
		} else if (includeToolCalls) {
			const meta = getToolMeta(part.tool, part.input);
			const detail = meta.detail ? ` ${meta.detail}` : "";
			chunks.push(`_${meta.label}${detail}_`);
		}
	}
	return chunks.join("\n\n");
}
