/**
 * Per-tool truncation policy for *seeding prior turns* into a fresh Agent's
 * context (issue #272).
 *
 * For an agent, what matters about a tool call is **the answer, not the raw
 * output** — and dilna knows the tool name, so no content-type detector or
 * AST parser is needed. The policy is a pure value: functions over
 * (tool name, tool input, output text) → a trimmed marker or `null`, with
 * zero dependencies (no Agent, no LLM, no I/O) so it is testable with
 * fixture strings and reusable from anywhere that needs to predict a trim —
 * the server's seeding path today, a measurement script, the web's
 * truncation UI tomorrow.
 *
 * Two invariants the callers own (the policy deliberately cannot violate
 * them):
 *
 * - **Trims apply only to prior turns.** A tool result is seeded verbatim
 *   in the turn that produced it — that is the turn the model is reasoning
 *   against — and only becomes eligible at the next cold start. The caller
 *   (buildInitialMessages' seed path) applies this policy exactly there.
 * - **Persisted rows are never rewritten.** The trim is a model's-view
 *   concern computed on copies at seed time; `messages` keeps the verbatim
 *   text and the web transcript renders it unchanged.
 *
 * `codegraph` and `task` get explicit no-ops — they already return
 * summaries, which is the point: the policy list stays short.
 */

/** Why a trim fired — recorded on the marker so callers can tell a
 * size cut from a "same as turn N" dedup without parsing the text
 * (issue #273's UI keys off it, and so can any future counter). */
export type TrimReason = "size" | "dedup";

/** What one trim decision produces. */
export type TrimmedToolOutput = {
	/** The tool whose output was trimmed (dilna's wire name). Consumers
	 * key behaviour off it — issue #274's re-read counter counts dedup
	 * trims of `read` only, since a repeated grep result set is not a
	 * re-read of a file. */
	tool: string;
	/** The replacement text seeded into the model's context (the marker,
	 * plus the retained head/tail for size trims). */
	seeded: string;
	/** The full original output — unchanged; the caller keeps it in the
	 * persisted row (and, from #273, on disk under its hash). */
	original: string;
	/** Content hash of the original output (caller-provided hasher, e.g.
	 * sha256 hex). The marker names it, so a person reading the transcript
	 * can find the original again. */
	hash: string;
	originalLines: number;
	originalChars: number;
	seededLines: number;
	/** What kind of trim this was (see {@link TrimReason}). */
	reason: TrimReason;
};

/** Cross-message state the seed walk maintains so result-set dedup can say
 * *which* earlier turn a repeated output matches. */
export type ToolTrimContext = {
	/** Human label for the turn currently being seeded ("turn 3") — what
	 * dedup markers will point back to. */
	turnLabel: string;
	/** identity (from {@link toolOutputIdentity}) → turn label of its first
	 * occurrence. Mutated by {@link applyToolOutputPolicy}. */
	seen: Map<string, string>;
};

/**
 * The knobs, as one value rather than loose constants — same shape as the
 * compaction settings, so a follow-up can loosen/tighten per provider or
 * per measurement without touching the policy logic.
 */
export const TOOL_OUTPUT_POLICY = {
	/** Only trim size when the output is at least this many lines. */
	minLines: 160,
	/** …or at least this many characters (whichever trips first). */
	minChars: 6_000,
	/** `read` keeps the file's head and tail — the imports/signature at the
	 * top and the error/return at the bottom are what an agent acts on. */
	headLines: 40,
	tailLines: 30,
	/** `bash` keeps the tail (where the exit summary and final errors live). */
	bashTailLines: 30,
	/** Lines matching any of these (case-insensitive) survive a `bash` trim
	 * even from the dropped middle — failures are the actionable part. */
	bashErrorPattern:
		/(error|fatal|traceback|exception|failed|permission denied|no such file)/i,
} as const;

/**
 * Identity of a tool result for dedup, when the tool's results are
 * repeatable: `read` of the same path returning the same bytes, `grep`/
 * `find` of the same pattern+path returning the same result set. The
 * content hash is part of the identity, so "same as turn N" also certifies
 * "the content is unchanged". `null` for tools whose outputs are never
 * meaningfully repeated.
 */
export function toolOutputIdentity(
	tool: string,
	input: unknown,
	output: string,
	hash: (text: string) => string,
): string | null {
	const contentHash = hash(output);
	const path = stringArg(input, "path");
	switch (tool) {
		case "read":
			return `read:${path ?? "?"}:${contentHash}`;
		case "grep":
			return `grep:${stringArg(input, "pattern") ?? "?"}:${path ?? "."}:${contentHash}`;
		case "find":
			return `find:${stringArg(input, "pattern") ?? "?"}:${path ?? "."}:${contentHash}`;
		default:
			return null;
	}
}

/**
 * Apply the policy to one tool result. Returns `null` when the output
 * should be seeded verbatim — below the size threshold, or from a tool with
 * no policy. `ctx` is required for the dedup policies (read re-reads,
 * grep/find result sets); pass it from any seed walk that wants them.
 */
export function applyToolOutputPolicy(
	tool: string,
	input: unknown,
	output: string,
	hash: (text: string) => string,
	ctx?: ToolTrimContext,
): TrimmedToolOutput | null {
	// Explicit no-ops (issue #272): both already return summaries — a trim
	// marker would cost more than it saves. Unknown tool names are left
	// alone too: the policy list stays short, and an unfamiliar output is
	// not dilna's to guess at.
	if (tool === "codegraph" || tool === "task" || !hasPolicy(tool)) {
		return null;
	}

	const originalLines = countLines(output);
	const originalChars = output.length;
	const atSize =
		originalLines >= TOOL_OUTPUT_POLICY.minLines ||
		originalChars >= TOOL_OUTPUT_POLICY.minChars;
	const contentHash = hash(output);

	// Result-set dedup runs regardless of size (a repeated 500-line read is
	// a no-op even though a single occurrence would be kept): the identity
	// already carries the content hash, so "same as turn N" certifies the
	// content is unchanged — a re-read of the same path and hash is
	// recognised as a no-op here.
	const identity = toolOutputIdentity(tool, input, output, hash);
	if (ctx && identity) {
		const first = ctx.seen.get(identity);
		if (first !== undefined) {
			return {
				tool,
				seeded: dedupMarker(tool, input, first, contentHash),
				original: output,
				hash: contentHash,
				originalLines,
				originalChars,
				seededLines: 1,
				reason: "dedup",
			};
		}
		ctx.seen.set(identity, ctx.turnLabel);
	}

	if (!atSize) return null;

	// A size trim must actually remove something: a read whose line count
	// fits inside head+tail (e.g. one 6KB minified line) would only gain a
	// marker, and bash's tail already covers short output.
	const reducible =
		tool === "read"
			? originalLines >
				TOOL_OUTPUT_POLICY.headLines + TOOL_OUTPUT_POLICY.tailLines
			: originalLines > TOOL_OUTPUT_POLICY.bashTailLines;
	if (!reducible) return null;

	switch (tool) {
		case "read":
			return trimRead(
				tool,
				input,
				output,
				originalLines,
				originalChars,
				contentHash,
			);
		case "bash":
			return trimBash(tool, output, originalLines, originalChars, contentHash);
		default:
			// grep/find first occurrences: dedup is their whole policy — a
			// result set is only useful in full once; afterwards it is a
			// repeat. Falling through here keeps them verbatim.
			return null;
	}
}

/** Tools with a size/dedup policy. `codegraph`/`task` are deliberate
 * no-ops (they summarise already); everything else unknown is conservative
 * verbatim. */
function hasPolicy(tool: string): boolean {
	return (
		tool === "read" || tool === "grep" || tool === "find" || tool === "bash"
	);
}

function trimRead(
	tool: string,
	input: unknown,
	output: string,
	originalLines: number,
	originalChars: number,
	contentHash: string,
): TrimmedToolOutput {
	const { headLines, tailLines } = TOOL_OUTPUT_POLICY;
	const lines = output.split("\n");
	const head = lines.slice(0, headLines);
	const tail = lines.slice(-tailLines);
	const removedLines = originalLines - headLines - tailLines;
	const path = stringArg(input, "path") ?? "(unknown path)";
	const seeded = [
		...head,
		`[dilna trimmed this tool output: read of ${path} — showing lines 1-${headLines} and ${originalLines - tailLines + 1}-${originalLines} of ${originalLines}; ${removedLines} lines / ${originalChars - seededChars(head, tail)} chars removed; content sha256 ${contentHash.slice(0, 16)} — a re-read of this path returns the same bytes (same hash), so re-reading to verify is a no-op]`,
		...tail,
	].join("\n");
	return {
		tool,
		seeded,
		original: output,
		hash: contentHash,
		originalLines,
		originalChars,
		seededLines: head.length + tail.length + 1,
		reason: "size",
	};
}

function trimBash(
	tool: string,
	output: string,
	originalLines: number,
	originalChars: number,
	contentHash: string,
): TrimmedToolOutput {
	const lines = output.split("\n");
	const keep = new Map<number, string>();
	const tailStart = Math.max(
		0,
		lines.length - TOOL_OUTPUT_POLICY.bashTailLines,
	);
	for (let i = tailStart; i < lines.length; i++) {
		const line = lines[i];
		if (line !== undefined) keep.set(i, line);
	}
	// Error-pattern lines survive from the dropped middle — the failure is
	// the actionable part of a long run.
	for (let i = 0; i < tailStart; i++) {
		const line = lines[i];
		if (line !== undefined && TOOL_OUTPUT_POLICY.bashErrorPattern.test(line))
			keep.set(i, line);
	}
	const kept = [...keep.entries()].sort((a, b) => a[0] - b[0]);
	const keptText = kept.map(([, l]) => l).join("\n");
	const seeded = `${keptText}\n[dilna trimmed this tool output: bash — showing the last ${TOOL_OUTPUT_POLICY.bashTailLines} lines${kept.length > TOOL_OUTPUT_POLICY.bashTailLines ? " plus error-pattern lines" : ""} of ${originalLines}; ${originalLines - kept.length} lines / ${originalChars - keptText.length} chars removed; content sha256 ${contentHash.slice(0, 16)}]`;
	return {
		tool,
		seeded,
		original: output,
		hash: contentHash,
		originalLines,
		originalChars,
		seededLines: kept.length + 1,
		reason: "size",
	};
}

function dedupMarker(
	tool: string,
	input: unknown,
	firstTurn: string,
	contentHash: string,
): string {
	const pattern = stringArg(input, "pattern");
	const path = stringArg(input, "path");
	const what =
		tool === "read"
			? `read of ${path ?? "(unknown path)"}`
			: `${tool}${pattern ? ` ${pattern}` : ""}${path ? ` in ${path}` : ""}`;
	return `[dilna trimmed this tool output: identical result to ${firstTurn} — ${what} returned the same content (sha256 ${contentHash.slice(0, 16)}); re-running it is a no-op, no new information]`;
}

function seededChars(head: string[], tail: string[]): number {
	return head.join("\n").length + tail.join("\n").length;
}

function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

function stringArg(input: unknown, key: string): string | undefined {
	if (input && typeof input === "object" && key in input) {
		const value = (input as Record<string, unknown>)[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}
