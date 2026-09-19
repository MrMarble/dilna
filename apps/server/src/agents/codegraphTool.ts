import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai/compat";
import { logger } from "../logger";

const execFileAsync = promisify(execFile);
const log = logger.child({ component: "agents/codegraphTool" });

/**
 * `codegraph` (issue #119, ADR-0044): the CodeGraph index that
 * `SessionManager.create` builds for every Worktree, exposed as a **tool**
 * instead of only reachable through the sandboxed bash tool.
 *
 * Issue #119 wired codegraph in as a CLI: the binary is installed in the
 * runtime image, `worktree.ts`'s `initCodegraph` indexes each fresh Worktree,
 * and `pi.ts` appends a system-prompt note naming `codegraph explore`. That
 * works, and the note alone was not enough to make the Agent reach for it —
 * dilna's own history shows a session finding `codegraph impact ArtefactKind`
 * useful and then doing the follow-up work with `rg` anyway. The cost was
 * structural rather than a matter of better prose: the graph was only
 * reachable as a bash command line the model had to reconstruct, invisible to
 * the tool list it weighs its tools against.
 *
 * ## One tool, and why it is `explore`
 *
 * Upstream's MCP server exposes a *single* tool. From their README:
 * "Measured agent behavior showed that one strong tool steers agents better
 * than a menu of narrower ones — fewer mis-picks, and it saves context every
 * session." The other seven (`node`, `search`, `callers`, `callees`,
 * `impact`, `files`, `status`) stay functional but unlisted, because
 * "everything they return already arrives inline on codegraph_explore".
 * Upstream measured that; there is no reason to re-derive it here, so dilna
 * takes the same shape. An Agent wanting `callers` asks explore a more
 * specific question and gets the blast-radius section.
 *
 * `codegraph explore` prints the same bytes as the MCP `codegraph_explore`
 * tool (upstream's own `explore --help`: "same output as the
 * codegraph_explore MCP tool"), so this wraps the CLI rather than reopening
 * the question of whether `pi-agent-core` should grow an MCP client.
 *
 * ## The description is the `initialize` handshake dilna cannot receive
 *
 * Upstream ships a server-level playbook in the MCP `initialize` response
 * (`dist/mcp/server-instructions.d.ts`) — reach for explore *before* reading
 * files, treat what it returns as already read, don't re-verify with grep,
 * don't hand-reconstruct a flow, check the staleness banner after editing.
 * `pi-agent-core` has no MCP client, so that handshake has nowhere to land;
 * the tool description below is the only equivalent surface, and it is a
 * *better* one — an Agent choosing between a dozen tools reads descriptions,
 * and the read/grep/find/ls descriptions it is choosing against say nothing
 * about code graph structure. Kept tight on purpose (a description is read
 * on every turn), with the long anti-pattern catalogue folded into the few
 * lines that change behaviour.
 *
 * ## Registration is per-Worktree, at the `existsSync` that gates the note
 *
 * `pi.ts` appends this tool only when the Worktree actually has a
 * `.codegraph/` directory — the same check that gates `CODEGRAPH_SYSTEM_PROMPT_NOTE`.
 * Passing a sibling Worktree's index is never an option: worktrees under one
 * repo are siblings on disk, two Sessions on the same repo run concurrently,
 * and upstream ships a worktree-mismatch warning precisely because an agent
 * in a nested worktree otherwise "silently trusts main-branch results"
 * (upstream issue #155).
 *
 * ## Failure is a result, not an error
 *
 * `pi-agent-core` derives a tool result's error flag solely from whether
 * `execute()` threw (ADR-0034 records this), and upstream's own dispatch
 * codes a missing index as a *success-shaped* answer for a measured reason:
 * "an `isError: true` early in a session teaches the agent the toolset is
 * broken and it stops calling codegraph entirely". So the one condition
 * that is genuinely routine here — a Worktree whose `codegraph init` failed
 * or whose repo the CLI can't parse — comes back as ordinary guidance text.
 * The tool shouldn't exist in that Session at all (it isn't registered), and
 * this is the belt to that suspenders.
 */

/** Optional knobs, named as upstream's CLI spells them rather than as the
 * model would: `max_files` mirrors `--max-files` and `path` mirrors
 * `--path`, so the tool's parameter names stay greppable against
 * codegraph's own docs and help output. */
const codegraphSchema = Type.Object({
	query: Type.String({
		description:
			'A natural-language question or a bag of symbol/file names, e.g. "how does SessionManager.create reach git worktree add" or "confinement hook sandbox bash".',
	}),
	max_files: Type.Optional(
		Type.Number({
			description:
				"Maximum number of files to include source from. Omit to let codegraph's own project-size-scaled budget decide — it is usually right.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				"Project path to query. Defaults to the worktree root, which is almost always what you want. Only meaningful for a sub-project that has its own .codegraph/ index.",
		}),
	),
});

/**
 * Hard ceiling on one call's output, applied here rather than left to
 * codegraph's own budget. Explore already scales its output to project size
 * (upstream issue #185), but that budget is tuned for a *read*: it is the
 * same payload, and upstream documents it leaving ~80% more context resident
 * at the end of a session than a grep-and-read loop would. Truncating
 * head-preserving keeps the ranked files and drops the tail, and the note
 * appended to a truncated result is what tells the model to narrow the query
 * rather than conclude the area is empty.
 */
export const CODEGRAPH_MAX_OUTPUT_CHARS = 40_000;

/** Bytes of stdout to buffer before aborting the child. Explore's own budget
 * is far below this; the cap exists so a pathological query can't buffer
 * unbounded output into the server process' memory before truncation. */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * A codegraph invocation that produced no usable answer *and* is not a
 * malfunction — today exactly "this project has no `.codegraph/` index".
 * Recognised by the CLI's own leading marker on stderr (`✗ CodeGraph isn't
 * available here`) rather than by exit code, because exit 1 is also what a
 * genuine error returns. See the module doc comment for why this becomes
 * result text instead of a thrown error.
 */
function isMissingIndex(stderr: string): boolean {
	return stderr.includes(MISSING_INDEX_MARKER);
}

/** The exact sentence {@link isMissingIndex} keys on, named so the test that
 * guards it against an upstream reword cannot drift from the check itself. */
export const MISSING_INDEX_MARKER = "CodeGraph isn't available here";

/**
 * The result of probing the installed CLI's surface (see
 * `codegraphCli.test.ts`). `available: false` means the binary could not be
 * spawned at all — a laptop running `pnpm test` without codegraph on `PATH`,
 * or a CI runner — which is *not* a failure: the tool is registered only when
 * a Worktree has an index, and the binary only exists in the runtime image.
 * Everything else is read from the binary itself and asserted against what
 * `createCodegraphTool` actually invokes.
 */
export type CodegraphSurface =
	| { available: false; reason: string }
	| {
			available: true;
			version: string;
			/** `explore --help`, for asserting the options the tool passes. */
			exploreHelp: string;
			/** Top-level `--help`, where `--no-color` is declared. */
			rootHelp: string;
			/** Whether a probe run of the *exact* argument shape
			 * `createCodegraphTool` builds was accepted — see the surface probe. */
			probeAccepted: boolean;
			/** Whether an unindexed directory still produces
			 * {@link MISSING_INDEX_MARKER} on stderr — the string the tool uses to
			 * tell "not indexed" (routine) apart from "broken" (a real error). */
			missingIndexMarker: boolean;
	  };

/**
 * Probe the installed codegraph CLI for the surface this tool depends on.
 *
 * Exists because the dependency is a **pinned subprocess**, which is the one
 * shape a type checker cannot see through: upstream ships roughly a release a
 * week (46 versions, `1.6.0` latest as of 2026-09), and a renamed flag or a
 * dropped subcommand would surface only as the tool returning "use grep/read
 * instead" in a live Session — silently, and with nothing in the logs. This
 * is what a test can assert against.
 *
 * `binary` is injectable so the caller can exercise the not-found path on a
 * machine that does have codegraph installed.
 */
export async function verifyCodegraphSurface(
	binary = "codegraph",
	/** Directory the acceptance probe runs against. Only needs an index for
	 * the success path to be observable; a lint failure (exit 2) already
	 * proves the arguments parsed, which is the thing being asserted. */
	probeDir = process.cwd(),
): Promise<CodegraphSurface> {
	const env = { ...process.env, NO_COLOR: "1" };
	try {
		const { stdout } = await execFileAsync(binary, ["--version"], { env });
		const [root, explore, missing, probe] = await Promise.all([
			execFileAsync(binary, ["--help"], { env }),
			execFileAsync(binary, ["explore", "--help"], { env }),
			// Deliberately against a directory with no index: this is the one
			// response shape the tool branches on, and the only branch whose
			// wording upstream owns.
			execFileAsync(binary, ["explore", "anything"], { cwd: "/" })
				.then(() => ({ stdout: "", stderr: "" }))
				.catch((err: { stdout?: string; stderr?: string }) => ({
					stdout: err.stdout ?? "",
					stderr: err.stderr ?? "",
				})),
			// The acceptance probe: byte-for-byte the argv `execute()` builds,
			// run in a directory that may or may not be indexed. Exit 2 is
			// commander rejecting an unknown option — anything else means the
			// shape parsed.
			execFileAsync(
				binary,
				[
					"explore",
					"probe",
					"--no-color",
					"--path",
					probeDir,
					"--max-files",
					"1",
				],
				{ cwd: probeDir, env },
			)
				.then(() => 0)
				.catch((err: { code?: number }) => err.code ?? 1),
		]);
		return {
			available: true,
			version: stdout.trim().replace(/^v/, ""),
			rootHelp: root.stdout,
			exploreHelp: explore.stdout,
			probeAccepted: probe !== 2,
			missingIndexMarker: (missing.stderr ?? "").includes(MISSING_INDEX_MARKER),
		};
	} catch (err) {
		return {
			available: false,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Append an explicit marker when the output was cut, so a truncated result
 * never reads as a complete one. Deliberately not silent: a model that
 * doesn't know it was cut will conclude the missing half doesn't exist.
 */
export function capOutput(
	text: string,
	maxChars = CODEGRAPH_MAX_OUTPUT_CHARS,
): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[codegraph output truncated at ${maxChars} characters. Narrow the query (name the symbol or file you actually need) or raise \`max_files\` to see the rest.]`;
}

export function createCodegraphTool(
	worktreePath: string,
): AgentTool<typeof codegraphSchema> {
	return {
		name: "codegraph",
		label: "CodeGraph",
		description: `Explore this worktree's pre-built code graph — symbols, call edges and import structure for every file in it, indexed when this session started.

Use this INSTEAD OF a grep/read loop whenever you need to understand or locate code: "how does X work", "where is X", "how does X reach Y", or surveying an area before changing it. ONE call returns the relevant symbols' verbatim, line-numbered source grouped by file — the same shape the read tool gives you, safe to edit from — plus the call paths between them (including dynamic-dispatch hops like callbacks and interface-to-implementation that grep cannot follow) and a blast-radius summary of what depends on what.

Reach for it before reading and while editing, not only for questions: because the blast radius comes back with the source, you edit with the affected callers already in view.

- Treat the source it returns as already read. Do not re-read it with \`read\` and do not re-verify it with grep — it comes from a full AST parse, and checking it by hand is slower and less accurate.
- Name the endpoints in one query to get the path between them, rather than reconstructing a flow by hand.
- To read a specific file or symbol, put its name or path in the query; you get its current line-numbered source with the call trail attached.
- If the result is not enough, call it again with more specific names. If it begins with a ⚠️ staleness banner, the files it names were edited since the last index sync — read those specific files; every file not listed is fresh.
- Falls back to nothing: plain grep/read/find/ls are unaffected and remain the right tools for config, docs, and anything codegraph doesn't index.`,
		parameters: codegraphSchema,
		execute: async (_toolCallId, params, signal) => {
			const args = [
				"explore",
				params.query,
				"--no-color",
				"--path",
				params.path ? params.path : worktreePath,
			];
			if (params.max_files !== undefined) {
				args.push("--max-files", String(params.max_files));
			}

			try {
				const { stdout, stderr } = await execFileAsync("codegraph", args, {
					cwd: worktreePath,
					maxBuffer: MAX_BUFFER_BYTES,
					signal,
					env: { ...process.env, NO_COLOR: "1" },
				});
				const text = capOutput(stdout.trim());
				// The CLI tolerates a missing index by exiting 0 in some
				// builds and 1 in others (both observed against 1.6.0); the
				// message is the stable signal, so check it here too.
				if (isMissingIndex(stderr) && !stdout.trim()) {
					return textResult(missingIndexText(worktreePath));
				}
				return textResult(text);
			} catch (err) {
				const { stdout, stderr } = err as {
					stdout?: string;
					stderr?: string;
				};
				// A non-zero exit with usable stdout is not a failure worth
				// suppressing: the CLI prints its answer and a trailing
				// warning that way.
				if (stdout?.trim() && !isMissingIndex(stderr ?? "")) {
					return textResult(capOutput(stdout.trim()));
				}
				if (isMissingIndex(stderr ?? "")) {
					return textResult(missingIndexText(worktreePath));
				}
				const message = err instanceof Error ? err.message : String(err);
				if (signal?.aborted) {
					return textResult(
						"The codegraph query was stopped before it finished.",
					);
				}
				log.warn({ err: message, query: params.query }, "codegraph failed");
				return textResult(
					`codegraph could not answer that: ${(stderr ?? message).trim().slice(0, 500)}. Use grep/read instead.`,
				);
			}
		},
	};
}

function missingIndexText(worktreePath: string): string {
	return `This worktree has no \`.codegraph/\` index (${worktreePath}), so codegraph can't answer here. Use grep/read/find/ls instead for this session. Indexing is not your call — don't run \`codegraph init\` yourself.`;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}
