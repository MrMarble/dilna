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
 * Only `"html"` exists today (v1 is HTML reports; see ADR-0032's Scope).
 * It's a closed union rather than a raw MIME type because the set of things
 * dilna can actually *render* is much smaller than the set of things an
 * Agent could publish, and the publish tool rejects anything outside it —
 * storing a file the UI has no way to show would be a worse failure than
 * refusing it at the call.
 */
export type ArtefactKind = "html";

/**
 * One published Artefact.
 *
 * Carries no bytes, for the same reason {@link Attachment} doesn't: this
 * shape travels in the context panel's list and in the `artefact_published`
 * stream event, neither of which needs the content. The bytes are fetched
 * separately from `GET /api/sessions/:sessionId/artefacts/:id`, under the
 * hostile header set ADR-0032 specifies.
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
 * in the panel's error state and the two must agree. Sized for a
 * self-contained HTML report (inline CSS, maybe a base64 image or two) —
 * generously above anything a model writes by hand, well below a size the
 * browser would struggle to render in an iframe.
 */
export const ARTEFACT_MAX_BYTES = 8 * 1024 * 1024;

/** Render a byte count for the artefact list. Mirrors
 * `formatAttachmentSize`'s rounding so the two lists don't disagree about
 * what "1.2 MB" means. */
export function formatArtefactSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
