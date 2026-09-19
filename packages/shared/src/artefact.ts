/**
 * Artefacts (issue #194, ADR-0032): a file an Agent produced and explicitly
 * *published* for the user to open, as opposed to a file it merely wrote
 * into its Worktree.
 *
 * This is ADR-0031's Attachment run backwards — user→Agent becomes
 * Agent→user — and the two shapes are deliberately symmetric: bytes on disk
 * outside every Worktree, metadata in a table, no content in the record
 * itself.
 *
 * The defining property is **immutability**: an Artefact is a copy taken at
 * publish time, not a pointer at a Worktree file. Republishing mints a new
 * Artefact rather than mutating one, so successive versions of a report
 * accumulate and can be compared. See ADR-0032 for why a reference into the
 * Worktree was rejected.
 */

/**
 * What an Artefact's bytes are, and therefore how the UI renders it.
 *
 * A closed union rather than a raw MIME type because the set of things dilna
 * can actually *render* is much smaller than the set of things an Agent could
 * publish, and the publish tool rejects anything outside it — storing a file
 * the UI has no way to show would be a worse failure than refusing it at the
 * call.
 *
 * `"html"` is the original v1 kind (ADR-0032) and the only one dilna treats as
 * **hostile**: the agent authored executable document markup, so it renders in
 * a fully sandboxed iframe under a `default-src 'none'` CSP. The kinds added
 * for ADR-0043 are all inert by comparison:
 *
 * - `"markdown"` is rendered by the **web** with the same component as chat
 *   messages. The server never turns agent-authored markdown into HTML, so
 *   there is no second HTML-injection surface to reason about.
 * - `"pdf"` is handed to the browser's native viewer, which is a separate
 *   process-level surface rather than dilna's origin.
 * - `"image"` is a plain bitmap.
 *
 * Deliberately **no `"svg"`**: SVG is executable document markup wearing an
 * image extension, so serving it under `Content-Disposition: inline` is the
 * same hazard as HTML with none of the sandboxing HTML gets. See ADR-0043.
 */
export type ArtefactKind = "html" | "markdown" | "pdf" | "image";

/**
 * The inline-artefact kinds, i.e. every kind whose bytes the browser renders
 * from an `img`/`embed` context where a sandboxed iframe would break it.
 *
 * Exists so the serve route and the viewer can ask "does this kind need the
 * HTML sandbox's header set, or the permissive one?" without either of them
 * re-listing the kinds and drifting from the other.
 */
export function isSandboxedKind(kind: ArtefactKind): boolean {
	return kind === "html";
}

/**
 * One published Artefact.
 *
 * Carries no bytes, for the same reason {@link Attachment} doesn't: this
 * shape travels in the context panel's list and in the `artefact_published`
 * stream event, neither of which needs the content. The bytes are fetched
 * separately from `GET /api/sessions/:sessionId/artefacts/:id`, under the
 * header set ADR-0032 specifies for {@link ArtefactKind} `"html"` and the
 * milder one ADR-0043 specifies for the inert kinds.
 */
export type Artefact = {
	id: string;
	sessionId: string;
	/** Human-readable label the Agent supplied, or the filename if it didn't.
	 * This is what the panel lists — a column of `report.html`s would give the
	 * user no way to tell which run produced which. */
	title: string;
	/** Basename of the published copy, sanitized. Shown as a secondary detail
	 * and used for the download filename. */
	filename: string;
	/** Path *inside the Worktree* the file was published from, relative to the
	 * Worktree root. Recorded for provenance — it tells the user which file in
	 * the repo this snapshot came from, which is not otherwise recoverable
	 * once the Worktree moves on. Never used to serve the bytes. */
	sourcePath: string;
	kind: ArtefactKind;
	mimeType: string;
	/** Bytes on disk, i.e. the size of the published copy. */
	size: number;
	createdAt: number;
};

/**
 * Hard cap on a published file, enforced in the server's publish path.
 *
 * Lives here rather than only server-side because the web renders the limit
 * in the panel's error state and the two must agree.
 *
 * Raised from ADR-0032's 8MB when PDFs were added (ADR-0043): 8MB was sized
 * for a self-contained HTML report (inline CSS, maybe a base64 image or two)
 * and is uncomfortably tight for a generated PDF, which is mostly embedded
 * fonts and images. 25MB still keeps a single artefact comfortably inside what
 * a browser will render in an iframe without stalling, while staying far below
 * the point where holding the bytes in a `Buffer` per request matters.
 */
export const ARTEFACT_MAX_BYTES = 25 * 1024 * 1024;

/** A short human label for a kind, used in the viewer header and the panel's
 * secondary line. Kept here beside {@link ArtefactKind} so the two cannot
 * drift: adding a kind without a label is a type error, not a missing word in
 * the UI. */
export function artefactKindLabel(kind: ArtefactKind): string {
	switch (kind) {
		case "html":
			return "HTML";
		case "markdown":
			return "Markdown";
		case "pdf":
			return "PDF";
		case "image":
			return "Image";
	}
}

/** Render a byte count for the artefact list. Mirrors
 * `formatAttachmentSize`'s rounding so the two lists don't disagree about
 * what "1.2 MB" means. */
export function formatArtefactSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
