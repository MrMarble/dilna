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
		description:
			"Publish an HTML file from this worktree so the user can open and view it rendered in the dilna UI. Use this whenever you have generated a report, dashboard, or any HTML document the user is meant to look at — writing the file alone only lets them read its source. A published artefact is an immutable snapshot: publish again after regenerating, and the user keeps both versions to compare. Only .html/.htm files can be published, and scripts do not run in the rendered view, so keep reports self-contained with inline CSS.",
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
