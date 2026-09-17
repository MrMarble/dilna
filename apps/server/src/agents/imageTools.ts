import type { Attachment } from "@dilna/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai/compat";
import { logger } from "../logger";
import { AttachmentRejectedError, sendImage } from "../sessions/attachments";

const log = logger.child({ component: "agents/imageTools" });

/**
 * `dilna_send_image` (issue #222, ADR-0038): the Agent's way to put a picture
 * *in the conversation*, as opposed to handing the user something to open.
 *
 * The complement of `dilna_publish_artefact`, and deliberately a separate
 * tool rather than a widening of it. An artefact is a document the user opens
 * from a side panel; an image sent here lands inline in the transcript, in
 * the place the Agent sent it. Before this existed, showing a screenshot
 * meant base64-inlining it into a throwaway HTML wrapper and publishing that
 * — which worked, but produced a panel entry to click rather than a picture
 * to look at.
 *
 * Sending is an explicit act for the same reason publishing is: inferring it
 * from write traffic would send every scratch PNG and test fixture the Agent
 * happened to touch.
 */

const sendImageSchema = Type.Object({
	path: Type.String({
		description:
			"Path to the image file to send, relative to the worktree root (e.g. 'screenshot.png').",
	}),
	caption: Type.Optional(
		Type.String({
			description:
				"Optional one-line caption shown with the image, e.g. 'The homepage after the fix'.",
		}),
	),
});

/** Injected rather than imported so this module doesn't reach into
 * `SessionManager` (the circular-import problem `OrchestratorDeps` solves the
 * same way). `onImageSent` is what puts the image in the live transcript
 * mid-turn, in the position it was sent, rather than at end-of-turn. */
export type ImageToolDeps = {
	sessionId: string;
	worktreePath: string;
	/** `toolCallId` is the call that sent the image — it's what lets the
	 * persisted row splice the picture in directly after this tool call's own
	 * part, matching the position the live view showed it in. */
	onImageSent: (
		attachment: Attachment,
		ctx: { toolCallId: string; caption?: string },
	) => void;
};

export function createSendImageTool(
	deps: ImageToolDeps,
): AgentTool<typeof sendImageSchema> {
	return {
		name: "dilna_send_image",
		label: "Send image",
		description:
			"Send an image from this worktree directly into the chat, so the user sees the picture inline in the conversation. Use this for a screenshot you captured, a chart or diagram you generated, or any image the user asked to see — writing the file alone only lets them read it in the diff panel. Supports PNG, JPEG, GIF and WebP up to 4MB. For an HTML report or dashboard, use dilna_publish_artefact instead.",
		parameters: sendImageSchema,
		execute: async (toolCallId, params) => {
			try {
				const attachment = sendImage({
					sessionId: deps.sessionId,
					worktreePath: deps.worktreePath,
					sourcePath: params.path,
				});
				const caption = params.caption?.trim() || undefined;
				deps.onImageSent(attachment, { toolCallId, caption });
				return {
					content: [
						{
							type: "text" as const,
							text: `Sent ${attachment.filename} to the chat. The user can see it inline in the conversation.`,
						},
					],
					details: {},
				};
			} catch (err) {
				if (err instanceof AttachmentRejectedError) {
					// Returned as tool output, not thrown: a rejection is something
					// the Agent can act on (fix the path, convert the file), so it
					// belongs in the transcript rather than failing the turn.
					return {
						content: [
							{ type: "text" as const, text: `Could not send: ${err.message}` },
						],
						details: {},
						isError: true,
					};
				}
				log.error({ sessionId: deps.sessionId, err }, "send image failed");
				return {
					content: [
						{
							type: "text" as const,
							text: "Could not send: an unexpected error occurred.",
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	};
}
