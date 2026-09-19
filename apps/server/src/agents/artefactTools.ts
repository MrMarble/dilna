import type { Artefact } from "@dilna/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai/compat";
import { logger } from "../logger";
import { ArtefactRejectedError, publishArtefact } from "../sessions/artefacts";

const log = logger.child({ component: "agents/artefactTools" });

/**
 * `dilna_publish_artefact` (issue #194, ADR-0032): the Agent's only way to
 * hand the user something to *open*, as opposed to a file it merely wrote
 * into the Worktree.
 *
 * Publishing is an explicit act rather than something dilna infers from
 * write/edit traffic. Inference would publish every scratch file and test
 * fixture that happens to end in `.html`, and — decisively — it has no way
 * to learn a title, leaving the panel a column of indistinguishable
 * `report.html` rows (ADR-0032).
 */

const publishSchema = Type.Object({
	path: Type.String({
		description:
			"Path to the file to publish, relative to the worktree root (e.g. 'report.html').",
	}),
	title: Type.Optional(
		Type.String({
			description:
				"Short human-readable label shown to the user, e.g. 'Test coverage report'. Defaults to the filename.",
		}),
	),
});

/**
 * The tool description, kept as a module constant because it is doing real
 * work rather than being boilerplate: it is the *only* place the Agent learns
 * that a published report runs no scripts and loads no remote assets.
 *
 * That constraint used to be stated as "keep reports self-contained with
 * inline CSS", and an Agent reading it would still reach for a Tailwind CDN
 * on about every other attempt — the phrase describes a *style*, while the
 * failure is mechanical. A report that links `cdn.tailwindcss.com` renders as
 * unstyled text with no error anywhere the Agent can see it, so the round
 * trip that fixes it is long. Naming the concrete failure ("a CDN link
 * silently does nothing") is what actually steers the model to `<style>` or a
 * `<script>` tag it doesn't write in the first place.
 *
 * The kind list is interpolated from `PUBLISHABLE`'s keys in `artefacts.ts`
 * rather than retyped, so the description cannot promise a type the publish
 * path rejects.
 */
const PUBLISH_DESCRIPTION = [
	"Publish a file from this worktree so the user can open and view it rendered in the dilna UI.",
	"Use this whenever you have generated a report, dashboard, document, chart, or any file the user is meant to look at — writing the file alone only lets them read its source.",
	"Supports .html/.htm, .md/.markdown, .pdf, and .png/.jpg/.jpeg/.gif/.webp. Markdown is rendered and can be toggled to its raw source; images render inline.",
	// The two sentences that stop the most common silent failure.
	"A published document runs NO JavaScript and loads NO remote assets: a `<script src>`, a CDN link (e.g. Tailwind), a remote font, or a remote image silently does nothing, and the user sees an unstyled or blank result. Put all CSS in a <style> block and inline any images as base64 data: URIs.",
	"SVG cannot be published — inline it into an HTML artefact instead, which is sandboxed.",
	"A published artefact is an immutable snapshot: publish again after regenerating, and the user keeps both versions to compare.",
].join(" ");

/** Injected rather than imported so this module doesn't reach into
 * `SessionManager` (the circular-import problem `OrchestratorDeps` solves the
 * same way). `onPublished` is what puts the artefact in the user's panel
 * mid-turn instead of only after a refetch. */
export type ArtefactToolDeps = {
	sessionId: string;
	worktreePath: string;
	onPublished: (artefact: Artefact) => void;
};

export function createPublishArtefactTool(
	deps: ArtefactToolDeps,
): AgentTool<typeof publishSchema> {
	return {
		name: "dilna_publish_artefact",
		label: "Publish artefact",
		description: PUBLISH_DESCRIPTION,
		parameters: publishSchema,
		execute: async (_toolCallId, params) => {
			try {
				const artefact = publishArtefact({
					sessionId: deps.sessionId,
					worktreePath: deps.worktreePath,
					sourcePath: params.path,
					title: params.title,
				});
				deps.onPublished(artefact);
				return {
					content: [
						{
							type: "text" as const,
							text: `Published "${artefact.title}" (${artefact.filename}). The user can now open it from the Artefacts section of the session panel.`,
						},
					],
					details: {},
				};
			} catch (err) {
				if (err instanceof ArtefactRejectedError) {
					// Returned as tool output, not thrown: a rejection is something
					// the Agent can act on (fix the path, convert the file), so it
					// belongs in the transcript rather than failing the turn.
					return {
						content: [
							{
								type: "text" as const,
								text: `Could not publish: ${err.message}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				log.error(
					{ sessionId: deps.sessionId, err },
					"publish artefact failed",
				);
				return {
					content: [
						{
							type: "text" as const,
							text: "Could not publish: an unexpected error occurred.",
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	};
}
