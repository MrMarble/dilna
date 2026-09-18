import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai/compat";
import { applyHashline, formatPatchResult } from "./hashlineEdit";
import { hashlineTag } from "./hashlineTag";

/**
 * The disk-facing half of the hashline contract (issue #138, item 1).
 *
 * Deliberately thin: read the bytes, call the pure engine
 * (`hashlineEdit.ts`/`hashlineFormat.ts`), write the bytes, render the reply.
 * Every rule about *what* an edit means lives in the engine, so this file only
 * has to get the I/O and the two tool descriptions right.
 *
 * Replaces pi-coding-agent's stock `read`/`edit` for dilna Sessions. The stock
 * tools are `str_replace`-style — the model quotes the old text and hopes it
 * matches — and provide no way for the model to see which version of a file it
 * is anchored to. These two share a tag instead:
 *
 *     read  ->  [src/a.ts#1A2B]
 *               4:const a = 1;
 *     edit  ->  path=src/a.ts tag=1A2B patch="PUT 4.=4:\n+const a = 2;"
 *
 * If the file changed in between, the tag no longer matches and the edit is
 * refused with the tag that is actually current — never applied to bytes the
 * model never saw. That refusal, and the `+TEXT`-final-content body rows, are
 * the two properties the whole design exists for.
 *
 * Confinement is unchanged and still external: `confinement.ts`'s
 * `beforeToolCall` hook gates these by the `path` argument, which is why these
 * tools keep the stock names and the flat `path` field even though they are
 * dilna's own implementations.
 */

/** Resolve a tool's `path` argument the way pi's own tools do — relative paths
 * are relative to the Session's worktree, absolute ones are taken as-is. The
 * confinement hook has already refused anything outside the worktree by the
 * time `execute` runs. */
function resolvePath(worktreePath: string, target: string): string {
	return path.isAbsolute(target) ? target : path.resolve(worktreePath, target);
}

/** Path shown in the header — repo-relative where possible, which is also what
 * the model should hand back as `path` on the next edit. */
function displayPath(worktreePath: string, absolutePath: string): string {
	const relative = path.relative(worktreePath, absolutePath);
	return relative.startsWith("..") ? absolutePath : relative;
}

const READ_TOOL_DESCRIPTION = `Read a file's contents, tagged and numbered for editing.

The first line is a header giving the file's snapshot tag; each following line is \`N:content\`, where N is the line's real number in the file.

Pass that tag back when you edit the file. If the file changes between this read and your edit, the edit is refused and told the current tag, so a stale edit can never corrupt a file.

Use \`offset\`/\`limit\` to read part of a long file — the line numbers shown are always the file's real ones, so they remain valid anchors for an edit even when you only read a portion.`;

const EDIT_TOOL_DESCRIPTION = `Edit an existing file using line-anchored \`PUT\` operations.

You must pass the \`tag\` from the most recent \`read\` or \`edit\` of this file. If the file has changed since then, the edit is refused with the tag that is current now — re-read and re-issue against that.

Operations, one per line, each followed by its body rows:
  PUT N.=M:  replace the inclusive original lines N..M
  PUT <N:    insert before line N (\`<1:\` is the file head)
  PUT >N:    insert after line N
  PUT >$:    append at the end of the file

Every body row starts with \`+\` and is the line's final content — write what the lines should *become*, never a before/after diff pair. A lone \`+\` inserts a blank line, so a literal line beginning with \`+\` is written \`++...\`.

Line numbers always refer to the file as you read it. An earlier operation in the same patch does not shift a later one, so you can address every line from that one read.

Example — in a file whose tag is 1A2B, rename a constant on line 4 and append a line:

  PUT 4.=4:
  +export const TIMEOUT_MS = 30;
  PUT >$:
  +export const READY = true;

To create a file, or replace one wholesale, use \`write\` instead.`;

const readParameters = Type.Object({
	path: Type.String({
		description:
			"Path to the file to read (relative to the worktree, or absolute)",
	}),
	offset: Type.Optional(
		Type.Number({
			description: "Line number to start reading from (1-indexed)",
		}),
	),
	limit: Type.Optional(
		Type.Number({ description: "Maximum number of lines to read" }),
	),
});

const editParameters = Type.Object({
	path: Type.String({
		description:
			"Path to the file to edit (relative to the worktree, or absolute)",
	}),
	tag: Type.String({
		description:
			"The 4-hex snapshot tag from the most recent read or edit of this file",
	}),
	patch: Type.String({
		description:
			"One or more `PUT` operations, each followed by its `+` body rows",
	}),
});

/** Hard cap on a read's returned lines, matching the neighbourhood of pi's own
 * read tool so a huge file can't blow the context in one call. */
const MAX_READ_LINES = 2000;

export function createHashlineReadTool(
	worktreePath: string,
): AgentTool<typeof readParameters> {
	return {
		name: "read",
		label: "Read file",
		description: READ_TOOL_DESCRIPTION,
		parameters: readParameters,
		execute: async (_toolCallId, { path: target, offset, limit }) => {
			const absolute = resolvePath(worktreePath, target);
			// Throws (and so surfaces an error result) when missing or unreadable
			// — matching the stock tool, which reports rather than returning "".
			const text = await readFile(absolute, "utf8");
			const shown = displayPath(worktreePath, absolute);

			// A trailing newline is a terminator, not an extra line.
			const allLines = text.endsWith("\n")
				? text.slice(0, -1).split("\n")
				: text.split("\n");
			const total = text === "" ? 0 : allLines.length;

			const startLine = offset !== undefined && offset > 0 ? offset : 1;
			const wanted =
				limit === undefined ? MAX_READ_LINES : Math.max(0, Math.floor(limit));
			const endLine = Math.min(total, startLine - 1 + wanted);

			const slice = allLines.slice(startLine - 1, endLine).join("\n");
			// Numbered from `startLine` because these are the file's real line
			// numbers — the anchors an edit will use. The *tag* is minted by
			// `formatTaggedLines` over the full `text` we pass it, never the
			// visible slice, so an edit anchored in a partial read still matches.
			const body =
				slice === ""
					? [`[${shown}#${hashlineTag(text)}]`]
					: numberedFrom(
							`[${shown}#${hashlineTag(text)}]`,
							`${slice}\n`,
							startLine,
						);

			const remaining = total - endLine;
			const suffix =
				remaining > 0
					? `\n\n[${remaining} more line${remaining === 1 ? "" : "s"}. Use offset=${endLine + 1} to continue.]`
					: "";

			return {
				content: [
					{ type: "text" as const, text: `${body.join("\n")}${suffix}` },
				],
				details: { path: shown, lines: allLines.length, totalLines: total },
			};
		},
	};
}

/** Render `header` plus the numbered lines of an already-windowed slice. The
 * caller slices (honouring offset/limit); this only numbers, since the numbers
 * must be the file's real ones. */
function numberedFrom(
	header: string,
	windowText: string,
	startLine: number,
): string[] {
	const body = windowText.endsWith("\n") ? windowText.slice(0, -1) : windowText;
	if (body === "") return [header];
	return [
		header,
		...body.split("\n").map((line, i) => `${startLine + i}:${line}`),
	];
}

export function createHashlineEditTool(
	worktreePath: string,
): AgentTool<typeof editParameters> {
	return {
		name: "edit",
		label: "Edit file",
		description: EDIT_TOOL_DESCRIPTION,
		parameters: editParameters,
		execute: async (_toolCallId, { path: target, tag, patch }) => {
			const absolute = resolvePath(worktreePath, target);
			const shown = displayPath(worktreePath, absolute);

			let text: string;
			try {
				text = await readFile(absolute, "utf8");
			} catch {
				// An edit never creates a file — that would bypass the anchor
				// guarantee entirely. `write` is the tool for creating.
				return {
					content: [
						{
							type: "text" as const,
							text: `Cannot edit ${shown}: it does not exist. Use \`write\` to create a new file.`,
						},
					],
					details: { path: shown },
					isError: true,
				};
			}

			const result = applyHashline({ text, tag, patch });
			if (!result.ok) {
				// A refusal is a normal outcome, not a crash: return the reason
				// (which carries the current tag) as the tool's output so the
				// model can act on it in the next round.
				return {
					content: [
						{
							type: "text" as const,
							text: `Edit refused for ${shown}. ${result.reason}`,
						},
					],
					details: { path: shown, tag: result.tag },
					isError: true,
				};
			}

			await writeFile(absolute, result.text, "utf8");

			return {
				content: [
					{
						type: "text" as const,
						text: `Applied to ${shown}.\n\n${formatPatchResult(shown, result.text, patch)}`,
					},
				],
				details: { path: shown, tag: result.tag },
			};
		},
	};
}
