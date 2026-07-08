import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDataDir } from "../db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * Walk up from `start` to find dilna's own monorepo root (marked by
 * `pnpm-workspace.yaml`). Used to locate dilna's own source directories so
 * they can be hidden from the sandboxed agent — separate from whether
 * `DILNA_DATA_DIR` happens to live inside that tree.
 */
function findWorkspaceRoot(start: string): string {
	let dir = start;
	while (true) {
		if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

/**
 * List `dir`'s immediate children and return the ones NOT in `keep`, for use
 * as `--fs-deny` targets. sandlock's `-r /` grants broad read for the tools
 * themselves to function (shared libs, PATH-resolved binaries, etc.); this
 * carves out everything under `dir` *except* the specific entries a given
 * session actually needs, so sibling repos/worktrees/sessions and dilna's own
 * source stay unreadable to the sandboxed agent despite the broad base grant.
 *
 * Denying a parent and re-allowing a path nested inside it does NOT work with
 * sandlock (`--fs-deny` always wins over a more specific `-r`/`-w`, verified
 * empirically) — so this denies only true siblings of what's kept, never an
 * ancestor of it.
 *
 * Only reflects siblings that exist at spawn time: a new sibling created
 * after this process starts (e.g. another session starting concurrently)
 * won't be in this list and will remain readable for this process's lifetime
 * — a known, low-severity gap (see ADR-0010).
 */
function denySiblings(dir: string, keep: Set<string>): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries
		.filter((name) => !keep.has(name))
		.map((name) => path.join(dir, name));
}

/**
 * Compute `--fs-deny` targets that hide everything dilna itself manages
 * *except* the one worktree/repo this session is actually using: other
 * repos' worktrees, other sessions' worktrees of the same repo, other repos'
 * bare clones, and (when `DILNA_DATA_DIR` lives inside dilna's own checkout,
 * as it does by default in local dev) dilna's own source directories —
 * `node_modules` is deliberately left un-denied since the agent backends'
 * own binaries and dependencies live there and aren't project data worth
 * hiding.
 */
function denyPathsOutsideSession(
	worktreePath: string,
	gitCommonDir: string | null,
): string[] {
	const deny: string[] = [];

	const repoWorktreesDir = path.dirname(worktreePath); // data/worktrees/<repo>
	const allWorktreesDir = path.dirname(repoWorktreesDir); // data/worktrees
	deny.push(
		...denySiblings(
			allWorktreesDir,
			new Set([path.basename(repoWorktreesDir)]),
		),
		...denySiblings(repoWorktreesDir, new Set([path.basename(worktreePath)])),
	);

	if (gitCommonDir) {
		const allReposDir = path.dirname(gitCommonDir); // data/repos
		deny.push(
			...denySiblings(allReposDir, new Set([path.basename(gitCommonDir)])),
		);
	}

	const dataDir = getDataDir();
	const workspaceRoot = findWorkspaceRoot(__dirname);
	if (dataDir.startsWith(`${workspaceRoot}${path.sep}`)) {
		const dataDirName = path
			.relative(workspaceRoot, dataDir)
			.split(path.sep)[0];
		deny.push(
			...denySiblings(
				workspaceRoot,
				new Set([dataDirName ?? "", "node_modules"]),
			),
		);
	}

	return deny;
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
};

/**
 * Wrap a command with sandlock (https://github.com/multikernel/sandlock) so
 * its only writable filesystem access is `cwd` — the session's worktree —
 * and its readable access excludes sibling repos, sibling worktrees, and
 * dilna's own source, even though the base grant (`-r /`) is broad. Read
 * confinement is layered on with `--fs-deny` (see {@link
 * denyPathsOutsideSession}) rather than narrowing `-r` directly, since the
 * tools themselves (node, git, bash, the agent binary) need broad read
 * access to system libraries and PATH-resolved binaries to function at all.
 *
 * This is what ADR-0003's safety justification for auto-approving every
 * tool call ("the agent runs in an isolated container... so the blast
 * radius is the worktree only") actually requires. Nothing previously
 * enforced that — `cwd` was only ever a convention, not a boundary, and an
 * agent could (and did) write outside its assigned worktree via an absolute
 * path or a `bash` tool call, or read sibling projects and dilna's own
 * source it had no reason to see.
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
 * advance.
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
	for (const denyPath of denyPathsOutsideSession(opts.cwd, gitCommonDir)) {
		sandlockArgs.push("--fs-deny", denyPath);
	}
	for (const p of writablePaths) {
		// Create it if missing — sandlock rejects a write rule for a path
		// that doesn't exist yet (e.g. a backend's own data dir on first run).
		if (p !== "/dev/null") mkdirSync(p, { recursive: true });
		sandlockArgs.push("-w", p);
	}
	sandlockArgs.push("--", opts.command, ...opts.args);

	return spawn("sandlock", sandlockArgs, {
		cwd: opts.cwd,
		env: opts.env,
		stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
		signal: opts.signal,
	});
}
