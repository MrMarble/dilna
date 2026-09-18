import { hashlineTag } from "./hashlineTag";

/**
 * The hashline edit engine (issue #138, item 1).
 *
 * A line-anchored patch language as a **pure function**: text in, text out. It
 * knows nothing about files, tools or sessions — `hashlineTools.ts` does the
 * disk work — which is what makes the whole language testable without a
 * fixture, and keeps every ordering and refusal rule in one readable place.
 *
 * The contract, ported from oh-my-pi's `hashline` mode:
 *
 *     PUT N.=M:   replace inclusive original lines N..M with the +rows below
 *     PUT <N:     insert the +rows immediately before line N (`<1:` = head)
 *     PUT >N:     insert the +rows immediately after line N
 *     PUT >$:     append the +rows at the file tail
 *
 * Three rules carry the value:
 *
 * 1. **Body rows are `+TEXT` final content, never a diff pair.** The model
 *    writes what the lines should *become*, so it never reproduces old text —
 *    which is where the retry loop on unmatched `oldText` comes from.
 * 2. **Every number is an original-snapshot number, never shifted by an
 *    earlier hunk.** Hunks are bucketed by anchor and applied in descending
 *    order, so an edit can't move the ground under a later one.
 * 3. **The tag is checked before anything is applied.** A stale tag refuses
 *    the whole patch and hands back the tag that is actually current.
 *
 * Deliberately *not* here (deferred, additive later without a contract change):
 * `N*` tree-sitter block anchors, `CUT`/register clipboard moves, `REM`/`MV`,
 * seen-line enforcement, and stale-tag recovery. See
 * `docs/research/omp-hashline-edit-engine.md` §3 for the staging rationale.
 */

export type HashlineApplied = {
	ok: true;
	/** The file's new content. */
	text: string;
	/** The new tag, so the Agent stays anchored without re-reading. */
	tag: string;
};

export type HashlineRefused = {
	ok: false;
	/** One line the Agent can act on. */
	reason: string;
	/** The tag the file actually has right now, when that's knowable — this is
	 * what turns a refusal into a one-round-trip retry instead of a re-read. */
	tag?: string;
};

export type HashlineResult = HashlineApplied | HashlineRefused;

/** A parsed `PUT` operation, addressed by original-snapshot line numbers. */
type Operation =
	| { kind: "replace"; start: number; end: number; body: string[] }
	| { kind: "insertBefore"; anchor: number; body: string[] }
	| { kind: "insertAfter"; anchor: number; body: string[] }
	| { kind: "append"; body: string[] };

/** A `PUT` target before its body rows are attached. Spelled out rather than
 * `Omit<Operation, "body">`, which over a union does not distribute — it
 * collapses to a single object type and loses every variant's fields. */
type OperationTarget =
	| { kind: "replace"; start: number; end: number }
	| { kind: "insertBefore"; anchor: number }
	| { kind: "insertAfter"; anchor: number }
	| { kind: "append" };

const OPERATION_HEADER = /^PUT\s+(.+?):\s*$/;

/**
 * Parse a patch into operations.
 *
 * Returns a refusal string rather than throwing: every failure here is a model
 * input error, and each one wants to come back as an actionable sentence.
 */
function parsePatch(patch: string): { ops: Operation[] } | { error: string } {
	const lines = patch.split("\n");
	const ops: Operation[] = [];
	let current: Operation | null = null;

	for (const line of lines) {
		// Rows starting with `++`/`+-` are literal content whose first character
		// happens to be the escape or a diff marker; stripped below.
		if (line.startsWith("+")) {
			if (!current) {
				return {
					error:
						"A body row appeared before any `PUT` header. Start each change with a `PUT` line.",
				};
			}
			if (!("body" in current)) {
				return {
					error: `\`${line}\` has nowhere to go — no \`PUT\` header is open.`,
				};
			}
			current.body.push(line.startsWith("++") ? line.slice(1) : line.slice(1));
			continue;
		}

		if (line.trim() === "") continue;

		const header = OPERATION_HEADER.exec(line);
		if (!header) {
			return {
				error: `\`${line}\` is not a hashline operation. Use \`PUT N.=M:\`, \`PUT <N:\`, \`PUT >N:\` or \`PUT >$:\`.`,
			};
		}

		const target = (header[1] as string).trim();
		const parsed = parseTarget(target);
		if (typeof parsed === "string") return { error: parsed };

		current = { ...parsed, body: [] } as Operation;
		ops.push(current);
	}

	if (ops.length === 0) {
		return { error: "No operations found in the patch." };
	}

	return { ops };
}

/** Parse the target of a `PUT` header, e.g. `4.=6`, `<2`, `>7`, `>$`. */
function parseTarget(target: string): OperationTarget | string {
	const range = /^(\d+)\.=(\d+)$/.exec(target);
	if (range) {
		const start = Number(range[1]);
		const end = Number(range[2]);
		if (start > end) {
			return `Range ${start}.=${end} is reversed — \`N.=M\` needs N ≤ M.`;
		}
		if (start < 1) return "Line numbers start at 1.";
		return { kind: "replace", start, end };
	}

	const before = /^<(\d+)$/.exec(target);
	if (before) {
		const anchor = Number(before[1]);
		if (anchor < 1) return "Line numbers start at 1.";
		return { kind: "insertBefore", anchor };
	}

	const after = /^>(\d+|\$)$/.exec(target);
	if (after) {
		// `>$` is the file tail. Handled before the numeric branch so the
		// anchor regex doesn't reject it.
		if (after[1] === "$") return { kind: "append" };
		const anchor = Number(after[1]);
		if (anchor < 1) return "Line numbers start at 1.";
		return { kind: "insertAfter", anchor };
	}

	return `\`${target}\` is not a valid target. Use \`N.=M\`, \`<N\`, \`>N\` or \`>$\`.`;
}

/**
 * Apply a parsed operation to the file's line array, in place.
 *
 * All anchors are original-snapshot numbers, so applying top-to-bottom would
 * let an earlier hunk shift a later anchor. They are therefore sorted by
 * position **descending** and applied last-to-first: every anchor still refers
 * to the lines it was written against when it is applied.
 */
function applyOperations(lines: string[], ops: Operation[]): string | null {
	// Sort key: for `replace`, its start. Every operation sorts by the line it
	// acts on, descending — so later edits land first and never move an earlier
	// anchor out from under it.
	const sorted = [...ops].sort((a, b) => position(b) - position(a));

	for (const op of sorted) {
		switch (op.kind) {
			case "replace": {
				if (op.end > lines.length) return null;
				lines.splice(op.start - 1, op.end - op.start + 1, ...op.body);
				break;
			}
			case "insertBefore": {
				if (op.anchor > lines.length) return null;
				lines.splice(op.anchor - 1, 0, ...op.body);
				break;
			}
			case "insertAfter": {
				if (op.anchor > lines.length) return null;
				lines.splice(op.anchor, 0, ...op.body);
				break;
			}
			case "append": {
				lines.push(...op.body);
				break;
			}
		}
	}
	return lines.join("\n");
}

function position(op: Operation): number {
	switch (op.kind) {
		case "replace":
			return op.start;
		case "insertBefore":
		case "insertAfter":
			return op.anchor;
		case "append":
			// Tail is always last; sorting it first would break inserts above it.
			return Number.MAX_SAFE_INTEGER;
	}
}

function toLines(text: string): string[] {
	// A trailing newline is a terminator, not an extra empty line — otherwise
	// `PUT >$:` would append after a phantom line, and line counts would be off
	// by one for every normal file.
	return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

export type ApplyHashlineInput = {
	/** The file's current content, exactly as read from disk. */
	text: string;
	/** The tag the Agent is anchored to — from its last `read`/`edit`. */
	tag: string;
	/** The patch body. */
	patch: string;
};

/**
 * Apply `patch` to `text`, but only if `tag` still describes `text`.
 *
 * The tag check comes first and refuses the *whole* patch: a partially applied
 * edit against a file that moved is exactly the corruption this exists to
 * prevent.
 */
export function applyHashline(input: ApplyHashlineInput): HashlineResult {
	const { text, tag, patch } = input;
	const currentTag = hashlineTag(text);

	if (currentTag !== tag.toUpperCase()) {
		return {
			ok: false,
			tag: currentTag,
			reason:
				`The file changed since it was read — its tag is now #${currentTag}, not #${tag.toUpperCase()}. ` +
				`Re-read the file and re-issue the edit against the new content.`,
		};
	}

	const parsed = parsePatch(patch);
	if ("error" in parsed) {
		return { ok: false, reason: parsed.error };
	}

	// An empty file is one empty line, so line 1 addresses it — matching how a
	// `read` of an empty file numbers it.
	const lines = text === "" ? [""] : toLines(text);
	const applied = applyOperations(lines, parsed.ops);
	if (applied === null) {
		return {
			ok: false,
			reason: `An anchor points past the end of the file (${lines.length} line${lines.length === 1 ? "" : "s"}).`,
		};
	}

	// Re-add the terminator a well-formed text file has.
	const nextText = applied === "" ? "" : `${applied}\n`;

	if (nextText === text) {
		return {
			ok: false,
			tag: currentTag,
			reason:
				"That edit would leave the file with no change — it is already byte-identical. " +
				"If the content is already correct, say so instead of re-issuing.",
		};
	}

	return { ok: true, text: nextText, tag: hashlineTag(nextText) };
}

/**
 * Render a successful edit for the Agent: the new tag plus a numbered window
 * around the changed lines, so it can chain a second edit without a re-read.
 */
export function formatPatchResult(
	path: string,
	text: string,
	patch: string,
	context = 2,
): string {
	const lines = toLines(text);
	const header = `[${path}#${hashlineTag(text)}]`;

	// Number every line the patch touched, plus a little context.
	const touched = new Set<number>();
	for (const raw of patch.split("\n")) {
		const match = OPERATION_HEADER.exec(raw);
		if (!match) continue;
		const target = (match[1] as string).trim();
		for (const n of target.match(/\d+/g) ?? []) {
			const value = Number(n);
			for (let i = value - context; i <= value + context; i++) {
				if (i >= 1 && i <= lines.length) touched.add(i);
			}
		}
	}

	if (touched.size === 0) return header;

	const numbers = [...touched].sort((a, b) => a - b);
	const body = numbers.map((n) => `${n}:${lines[n - 1] ?? ""}`);
	return [header, ...body].join("\n");
}
