import type { MessagePart } from "@dilna/shared";
import { attachmentUrl } from "@/api/client";
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
 *
 * Attachments become ordinary markdown links (image syntax for the image
 * kind), pointing at the API URL that serves the bytes. Deliberately *not*
 * gated by `includeToolCalls`: that flag exists to suppress the agent's tool
 * noise, whereas an attachment is content the user themselves put in the
 * message — dropping it would make the copy say less than the user wrote.
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
		} else if (part.type === "attachment") {
			const { filename, sessionId, id, kind } = part.attachment;
			const url = attachmentUrl(sessionId, id);
			chunks.push(`${kind === "image" ? "!" : ""}[${filename}](${url})`);
		} else if (includeToolCalls) {
			const meta = getToolMeta(part.tool, part.input);
			const detail = meta.detail ? ` ${meta.detail}` : "";
			chunks.push(`_${meta.label}${detail}_`);
		}
	}
	return chunks.join("\n\n");
}
