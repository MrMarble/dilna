import { hashlineTag } from "./hashlineTag";

/**
 * The read-side half of the hashline contract (issue #138, item 1).
 *
 * Stock `read` hands the model raw file text; hashline needs it to see *which*
 * file version it is looking at and *which* lines it may anchor to. This module
 * renders that: a `[path#TAG]` header followed by 1-indexed numbered lines.
 *
 *     [src/config.ts#1A2B]
 *     4:export const DEFAULT_TIMEOUT_SECONDS = 30;
 *     5:export const MAX_RETRY_ATTEMPTS = 3;
 *
 * Pure — takes text, returns text. The tool wrapper that reads from disk lives
 * in `hashlineTools.ts`; nothing here touches the filesystem, which is what
 * lets the format be pinned by tests without a fixture.
 */

export type FormatTaggedLinesOptions = {
	/** 1-indexed line number the passed `text` starts at. A partial read (pi's
	 * `offset`) shows a slice, but the numbers rendered must be the *file's*
	 * real ones — those are what an edit later anchors to. Defaults to 1. */
	startLine?: number;
};

/**
 * Render `text` as a tagged, numbered block.
 *
 * `text` is always the **whole file** (the caller reads it whole and slices for
 * display), because the tag must identify the file an edit will apply to. A tag
 * minted over a visible slice would never match on edit.
 */
export function formatTaggedLines(
	path: string,
	text: string,
	options: FormatTaggedLinesOptions = {},
): string {
	const { startLine = 1 } = options;
	const header = `[${path}#${hashlineTag(text)}]`;

	// A trailing newline is a line terminator, not an extra empty line — without
	// this, every file would render a phantom final line the model could try to
	// anchor to.
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	if (body === "") return header;

	const lines = body
		.split("\n")
		.map((line, index) => `${startLine + index}:${line}`);
	return [header, ...lines].join("\n");
}
