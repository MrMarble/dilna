import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * A git worktree's `.git` is a *file* (not a directory) pointing at its own
 * metadata directory (HEAD, index, refs, logs) under the origin repo's git
 * dir — e.g. `<bare-repo>/worktrees/<session-id>/`. That metadata dir's own
 * `commondir` file in turn points at the *shared* git dir (objects, refs,
 * config) — normally `../..`, i.e. the bare repo root itself. `git add`
 * needs to write new blob objects there, not just the per-worktree
 * metadata, since the object store is shared across every worktree of the
 * same repo by design. Granting write access to that shared root is safe
 * within dilna's model: it's the same Repo's own plumbing, not another
 * session's private data or unrelated host state.
 *
 * Both files are read directly rather than reconstructing git's internal
 * layout, so this is resilient to however the repo was cloned (bare or
 * not) and to git's own layout changing.
 */
function resolveGitCommonDir(worktreePath: string): string | null {
	try {
		const dotGit = readFileSync(path.join(worktreePath, ".git"), "utf8");
		const match = dotGit.match(/^gitdir:\s*(.+)$/m);
		const worktreeGitDir = match?.[1]?.trim();
		if (!worktreeGitDir) return null;

		const commondir = readFileSync(
			path.join(worktreeGitDir, "commondir"),
			"utf8",
		).trim();
		return path.resolve(worktreeGitDir, commondir);
	} catch {
		return null;
	}
}

export type SandboxSpawnOptions = {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdio?: SpawnOptions["stdio"];
	signal?: AbortSignal;
	/**
	 * Additional paths the agent backend itself needs write access to (its
	 * own cache/log/data directories — not project files). Created if
	 * missing, since the parent is read-only inside the sandbox.
	 */
	writablePaths?: string[];
};

/**
 * Wrap a command with bubblewrap (bwrap) so its only writable filesystem
 * access is `cwd` — the session's worktree. Everything else on the host is
 * bind-mounted read-only inside the sandbox's own mount namespace.
 *
 * This is what ADR-0003's safety justification for auto-approving every
 * tool call ("the agent runs in an isolated container... so the blast
 * radius is the worktree only") actually requires. Nothing previously
 * enforced that — `cwd` was only ever a convention, not a boundary, and an
 * agent could (and did) write outside its assigned worktree via an absolute
 * path or a `bash` tool call.
 *
 * The network namespace is intentionally left shared — agents need
 * outbound access for LLM provider APIs and git remotes. This restricts
 * filesystem writes only, not network egress or process visibility.
 */
export function spawnSandboxed(opts: SandboxSpawnOptions): ChildProcess {
	const gitCommonDir = resolveGitCommonDir(opts.cwd);
	const writablePaths = gitCommonDir
		? [...(opts.writablePaths ?? []), gitCommonDir]
		: (opts.writablePaths ?? []);

	const bwrapArgs = [
		"--die-with-parent",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
	];
	// A private /tmp gives the agent its own scratch space instead of the
	// host's real one — but if any writable path is itself under /tmp (e.g.
	// dilna's own data dir configured there), replacing /tmp would also hide
	// the *rest* of that path's real siblings (a bare repo's objects/refs
	// alongside the one worktree subdirectory we bind), which breaks git's
	// own worktree resolution ("not a git repository: (null)"). Skip the
	// replacement in that case and fall back to /tmp being read-only like
	// the rest of `/`, carved out by the same explicit binds as everywhere.
	const anyPathUnderTmp = [opts.cwd, ...writablePaths].some((p) =>
		p.startsWith("/tmp/"),
	);
	if (!anyPathUnderTmp) {
		bwrapArgs.push("--tmpfs", "/tmp");
	}
	bwrapArgs.push("--bind", opts.cwd, opts.cwd);
	for (const p of writablePaths) {
		// Create it if missing — the parent is read-only inside the sandbox,
		// so the backend can't create its own data dir on first run.
		mkdirSync(p, { recursive: true });
		bwrapArgs.push("--bind", p, p);
	}
	bwrapArgs.push("--chdir", opts.cwd, "--", opts.command, ...opts.args);
	return spawn("bwrap", bwrapArgs, {
		cwd: opts.cwd,
		env: opts.env,
		stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
		signal: opts.signal,
	});
}
