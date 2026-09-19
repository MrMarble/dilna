import type { Artefact } from "@dilna/shared";
import { artefactKindLabel } from "@dilna/shared";
import { Code2, ExternalLink, Eye } from "lucide-react";
import { useState } from "react";
import { artefactUrl } from "@/api/client";
import { ArtefactBody, useArtefactText } from "@/components/artefact-render";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

/**
 * Full-screen preview of a published Artefact (issue #194/ADR-0032 for HTML,
 * ADR-0043 for markdown/PDF/image).
 *
 * This component owns the dialog *chrome* — header, kind badge, raw toggle,
 * escape hatch — and delegates the body to `ArtefactBody`, which dispatches per
 * kind. The security reasoning for each renderer lives there and on the serve
 * route; what matters at this level is that the dialog never decides how bytes
 * are shown, only which affordances surround them.
 *
 * A markdown artefact gets a rendered/raw toggle. The fetch is owned *here*
 * rather than by either mode, because the two swap on every toggle and the
 * bytes are immutable — see `useArtefactText`.
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
	const [raw, setRaw] = useState(false);
	// Both hooks run before the early return below, so `useArtefactText` is
	// written to tolerate `null` rather than forcing a conditional hook.
	const text = useArtefactText(sessionId, artefact);

	// Reset raw mode whenever the artefact changes: raw carried over to a
	// *different* markdown file is a state the user never asked for. Done during
	// render — React's documented "adjust state when a prop changes" pattern —
	// rather than in an effect, which would paint one frame of the new artefact
	// in the previous one's mode.
	const [lastId, setLastId] = useState(artefact?.id);
	if (lastId !== artefact?.id) {
		setLastId(artefact?.id);
		setRaw(false);
	}

	if (!artefact) return null;
	const src = artefactUrl(sessionId, artefact.id);
	const canToggleRaw = artefact.kind === "markdown";

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
					{canToggleRaw && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setRaw((r) => !r)}
							title={raw ? "Show rendered" : "Show raw source"}
							aria-label={raw ? "Show rendered" : "Show raw source"}
						>
							{raw ? (
								<>
									<Eye className="size-4" />
									Rendered
								</>
							) : (
								<>
									<Code2 className="size-4" />
									Raw
								</>
							)}
						</Button>
					)}
					<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
						{artefactKindLabel(artefact.kind)}
					</span>
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
				<ArtefactBody
					// Keyed by id so switching artefacts replaces the frame rather
					// than reusing one whose document has already loaded.
					key={artefact.id}
					sessionId={sessionId}
					artefact={artefact}
					raw={raw}
					text={text}
				/>
			</DialogContent>
		</Dialog>
	);
}
