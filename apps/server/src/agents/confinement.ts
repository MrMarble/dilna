import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import type {
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";

/**
 * `pi-coding-agent`'s six filesystem tools (`read`/`write`/`edit`/`grep`/
 * `find`/`ls`) have no worktree confinement built in — confirmed by reading
 * their `execute()` bodies directly (see docs/research/pi-tool-confinement.md,
 * branch `research/pi-tool-confinement`): each resolves its `path` argument
 * via the package's own `resolveToCwd()` and touches the filesystem/spawns
 * `rg`/`fd` with no containment check. `bash` is covered separately by
 * `sandbox-runtime`'s existing `wrapWithSandbox` path (see pi.ts) — this set
 * is deliberately just the six tools whose `path`-shaped argument this
 * module inspects.
 */
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

/**
 * Resolve `candidatePath` to its real, symlink-free form, tolerating a leaf
 * (or several trailing components) that doesn't exist yet — e.g. a `write`
 * to a brand-new file, or one nested under directories the tool is about to
 * create. Walks up to the nearest ancestor that actually exists, resolves
 * *that* through `realpathSync`, then re-appends the not-yet-existing
 * trailing components lexically.
 *
 * This is the fix for a bypass a naive "realpathSync fails → trust the
 * lexical path" fallback leaves open: `realpathSync` also throws ENOENT when
 * an existing intermediate *symlink's target* is missing or when it can't
 * fully resolve a component, not just when the leaf itself is absent — so a
 * lexical fallback can't tell "this is a genuinely new file directly in the
 * worktree" apart from "this is a new file underneath a symlink that
 * resolves outside the worktree" (e.g. `ln -s / worktree/escape` followed by
 * `write({path:"escape/pwn.txt"})`: naively falling back to the lexical path
 * reports `escape/pwn.txt` as worktree-relative and safe, while the real
 * write — which does resolve the symlink — lands at the host filesystem
 * root). Resolving the nearest *existing* ancestor closes this: `escape`
 * itself exists (it's a valid symlink) and resolves to `/`, so the
 * reconstructed path is `/pwn.txt` — correctly outside the worktree.
 */
function realpathOrNearestExisting(candidatePath: string): string {
	let current = candidatePath;
	const trailing: string[] = [];
	while (true) {
		try {
			return join(realpathSync(current), ...trailing);
		} catch {
			const parent = dirname(current);
			if (parent === current) return join(current, ...trailing);
			trailing.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * Whether `candidateAbsolutePath` resolves inside `worktreeRoot`, following
 * symlinks on both sides first (see {@link realpathOrNearestExisting} for
 * why a not-yet-existing leaf can't just fall back to the lexical path
 * unresolved). `pi-coding-agent`'s own path resolution (`resolveToCwd`/
 * `resolvePath`) is lexical only — it never calls `realpathSync` — so a
 * symlink planted inside the worktree pointing outside it would defeat a
 * containment check that only compares the tool-resolved path lexically.
 */
export function isContained(
	candidateAbsolutePath: string,
	worktreeRoot: string,
): boolean {
	const real = realpathOrNearestExisting(candidateAbsolutePath);
	const realRoot = realpathOrNearestExisting(worktreeRoot);
	const rel = relative(realRoot, real);
	return (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
	);
}

/**
 * `beforeToolCall` hook (see `pi.ts`'s `startPi`) that blocks any of the six
 * path-taking tools from touching a path outside the session's worktree.
 * Runs before the tool's own `execute()` — per
 * `pi-agent-core`'s loop implementation, returning `{ block: true }` here is
 * a hard, structural short-circuit; `execute()` is never reached (see the
 * research doc's §2 for the traced call path). Reimplements `resolveToCwd`'s
 * absolute-or-relative-to-cwd resolution ourselves rather than trusting the
 * tool to have done it safely yet, since this hook runs strictly before that.
 */
export function createConfinementHook(
	worktreeRoot: string,
): (
	context: BeforeToolCallContext,
) => Promise<BeforeToolCallResult | undefined> {
	return async (context) => {
		if (!PATH_TOOLS.has(context.toolCall.name)) return undefined;
		const rawPath = (context.args as { path?: unknown }).path;
		const pathArg =
			typeof rawPath === "string" && rawPath.length > 0 ? rawPath : ".";
		// Match pi-coding-agent's own `resolveToCwd`/`normalizePath`, which
		// expands a leading `~`/`~/...` to the real host home directory by
		// default (`expandTilde` defaults to `true`, confirmed in the
		// installed `dist/utils/paths.js`) *before* this hook ever gets a
		// chance to see the resolved form — without matching that here,
		// `~/.ssh/id_rsa` would lexically resolve to a worktree-relative
		// path named "~", pass containment, and then the real tool call
		// would expand it to the host's actual `~/.ssh/id_rsa` and read it.
		const expanded =
			pathArg === "~"
				? homedir()
				: pathArg.startsWith("~/")
					? join(homedir(), pathArg.slice(2))
					: pathArg;
		const absolute = isAbsolute(expanded)
			? resolve(expanded)
			: resolve(worktreeRoot, expanded);
		if (!isContained(absolute, worktreeRoot)) {
			return {
				block: true,
				reason: `"${pathArg}" resolves outside the worktree. Refusing.`,
			};
		}
		return undefined;
	};
}
