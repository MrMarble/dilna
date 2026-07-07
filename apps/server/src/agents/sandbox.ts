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
	 * missing, since sandlock rejects write rules for paths that don't exist.
	 */
	writablePaths?: string[];
	/**
	 * TCP ports the sandboxed process needs to bind/listen on — sandlock
	 * denies all inbound binding by default. Only opencode needs this (its
	 * `serve` HTTP server); the Claude Agent SDK subprocess communicates
	 * over stdio and needs none.
	 */
	allowBindPorts?: number[];
};

/**
 * Wrap a command with sandlock (https://github.com/multikernel/sandlock) so
 * its only writable filesystem access is `cwd` — the session's worktree.
 * Everything else on the host is readable but not writable, enforced via
 * Landlock + seccomp rather than a mount namespace.
 *
 * This is what ADR-0003's safety justification for auto-approving every
 * tool call ("the agent runs in an isolated container... so the blast
 * radius is the worktree only") actually requires. Nothing previously
 * enforced that — `cwd` was only ever a convention, not a boundary, and an
 * agent could (and did) write outside its assigned worktree via an absolute
 * path or a `bash` tool call.
 *
 * Chosen over bubblewrap (the first implementation — see ADR-0010) because
 * it runs unprivileged inside a plain Docker/Kubernetes container with a
 * single narrow capability (`SYS_PTRACE`) and no seccomp/AppArmor profile
 * changes; bwrap needs `CAP_SYS_ADMIN` plus disabling both of those
 * entirely, which is a much bigger ask for a Kubernetes deployment.
 *
 * Unlike bwrap (which just shares the host's network namespace), sandlock
 * denies all networking by default — both outbound connect and inbound
 * bind. Outbound is opened unconditionally here (`--net-allow '*'` +
 * `udp://*`): agents need it for LLM provider APIs, git remotes, and
 * whatever else they're asked to fetch, none of which is enumerable in
 * advance. This sandboxes filesystem writes (and, incidentally, inbound
 * listening) only — not outbound egress or process visibility.
 */
export function spawnSandboxed(opts: SandboxSpawnOptions): ChildProcess {
	const gitCommonDir = resolveGitCommonDir(opts.cwd);
	const writablePaths = [
		opts.cwd,
		// git needs to redirect stdio through /dev/null during add/commit;
		// Landlock doesn't expose device nodes through the generic `-r /`
		// read grant the way a mount-namespace tool like bwrap would.
		"/dev/null",
		...(gitCommonDir ? [gitCommonDir] : []),
		...(opts.writablePaths ?? []),
	];

	const sandlockArgs = [
		"run",
		"-r",
		"/",
		"--cwd",
		opts.cwd,
		"--net-allow",
		"*",
		"--net-allow",
		"udp://*",
	];
	for (const p of writablePaths) {
		// Create it if missing — sandlock rejects a write rule for a path
		// that doesn't exist yet (e.g. a backend's own data dir on first run).
		if (p !== "/dev/null") mkdirSync(p, { recursive: true });
		sandlockArgs.push("-w", p);
	}
	for (const port of opts.allowBindPorts ?? []) {
		sandlockArgs.push("--net-allow-bind", String(port));
	}
	sandlockArgs.push("--", opts.command, ...opts.args);

	return spawn("sandlock", sandlockArgs, {
		cwd: opts.cwd,
		env: opts.env,
		stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
		signal: opts.signal,
	});
}
