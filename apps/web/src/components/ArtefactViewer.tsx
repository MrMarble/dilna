import type { Artefact } from "@dilna/shared";
import { ExternalLink } from "lucide-react";
import { artefactUrl } from "@/api/client";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/**
 * Full-screen preview of a published Artefact (issue #194, ADR-0032).
 *
 * The content is **model-generated HTML**, so it renders inside a
 * `<iframe sandbox>` with no tokens granted: no scripts, no forms, no
 * same-origin access, no top-level navigation. That is one of two independent
 * layers — the server also serves the bytes under a restrictive
 * `Content-Security-Policy` (see the artefacts route and ADR-0032). Either
 * alone would be sufficient today; both exist because the failure mode of
 * getting this wrong is an Agent-authored page with full access to dilna's
 * unauthenticated API on the user's own origin.
 *
 * Do not add `allow-scripts` to make a report "work properly". A report that
 * needs JavaScript is out of scope by decision, not by oversight — adding it
 * alongside `allow-same-origin` re-opens exactly the hole the sandbox closes.
 */
export function ArtefactViewer({
	sessionId,
	artefact,
	onClose,
}: {
	sessionId: string;
	/** The artefact to show; `null` keeps the dialog closed. */
	artefact: Artefact | null;
	onClose: () => void;
}) {
	if (!artefact) return null;
	const src = artefactUrl(sessionId, artefact.id);
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="flex h-[85vh] max-w-5xl flex-col gap-0 p-0 sm:max-w-5xl">
				<DialogHeader className="shrink-0 flex-row items-center gap-3 border-b border-border px-4 py-3">
					<div className="min-w-0 flex-1">
						<DialogTitle className="truncate text-sm">
							{artefact.title}
						</DialogTitle>
						<p className="truncate text-xs text-muted-foreground">
							{artefact.sourcePath}
						</p>
					</div>
					<a
						href={src}
						target="_blank"
						rel="noreferrer"
						title="Open in a new tab"
						aria-label="Open in a new tab"
						className="mr-6 shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<ExternalLink className="size-4" />
					</a>
				</DialogHeader>
				<iframe
					// Keyed by id so switching artefacts replaces the frame rather
					// than reusing one whose document has already loaded.
					key={artefact.id}
					src={src}
					title={artefact.title}
					sandbox=""
					className="min-h-0 flex-1 rounded-b-lg bg-white"
				/>
			</DialogContent>
		</Dialog>
	);
}
