import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CommitInfo } from "@dilna/shared";
import { logger } from "../logger";

const log = logger.child({ component: "sessions/worktree" });

const execFileAsync = promisify(execFile);

/**
 * Every `git` shell-out `SessionManager` performs on a Session's Worktree,
 * extracted (issue #149) so `create`/`delete` read as lifecycle steps
 * instead of interleaving DB writes with argv arrays and their cleanup
 * fallbacks.
 *
 * Scope boundary: these functions know about paths and branches, never
 * about Session rows or broadcasting. Repo-level git (clone, default-branch
 * resolution) stays in `repos/manager.ts` — this module is only the
 * per-Worktree half.
 */

export async function git(args: string[], opts: { cwd?: string } = {}) {
	return execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });
}

/**
 * Create the Session's Worktree and its branch, off the Repo's default
 * branch. Parent directories are created first — `git worktree add` won't
 * do it. Throws with git's own stderr attached, since "worktree add failed"
 * alone is never enough to diagnose.
 *
 * An empty Repo (e.g. a freshly created GitHub repository cloned before its
 * first commit) has an unborn default branch: the ref exists only as HEAD's
 * symref, so `git worktree add ... <base>` fails with "fatal: invalid
 * reference: <base>". Session creation must still work there — the agent is
 * how the repo gets its first code — so an unborn base registers an orphan
 * Worktree instead: an unborn HEAD on the Session branch, with nothing
 * checked out. The first commit the Agent makes becomes the branch's root.
 */
export async function createWorktree(opts: {
	repoPath: string;
	worktreePath: string;
	branchName: string;
	baseBranch: string;
}): Promise<void> {
	mkdirSync(path.dirname(opts.worktreePath), { recursive: true });
	if (await isUnbornBranch(opts.repoPath, opts.baseBranch)) {
		await createOrphanWorktree(opts);
		return;
	}
	try {
		await git(
			[
				"worktree",
				"add",
				"-b",
				opts.branchName,
				"--",
				opts.worktreePath,
				opts.baseBranch,
			],
			{ cwd: opts.repoPath },
		);
	} catch (err) {
		const e = err as { stderr?: string; message?: string };
		throw new Error(
			`git worktree add failed: ${e.stderr?.trim() || e.message}`,
		);
	}
}

/** True when `branch` exists only as a name (no commit backs the ref) — the
 * default branch of a Repo cloned from an empty remote, or any repo with no
 * commits at all. */
export async function isUnbornBranch(
	repoPath: string,
	branch: string,
): Promise<boolean> {
	try {
		await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
			cwd: repoPath,
		});
		return false;
	} catch {
		return true;
	}
}

/**
 * Register a linked Worktree on an unborn branch, without a checkout. This
 * hand-writes the exact on-disk layout `git worktree add` produces for a
 * linked worktree — because the one-piece command can't express it: on an
 * unborn base it wants a commit-ish to check out, and its `--orphan` option
 * that does exist needs git ≥2.42, while the Docker image (Debian bookworm)
 * ships 2.39. The layout is git's public worktree plumbing and stable since
 * 2.5: <worktree>/.git points at an admin dir under the bare repo's
 * worktrees/, the admin dir's gitdir points back at <worktree>/.git, its
 * HEAD is an unborn symref on the Session branch, and its commondir shares
 * the bare repo's object store and refs. status/commit/worktree
 * list/remove all treat the result as a worktree like any other (verified
 * against 2.39 in sessions/create-on-empty-repo.test.ts).
 */
async function createOrphanWorktree(opts: {
	repoPath: string;
	worktreePath: string;
	branchName: string;
}): Promise<void> {
	// git names a linked worktree's admin dir after the worktree dir's
	// basename; Session ids are unique per Repo, so no collision handling.
	const adminDir = path.join(
		opts.repoPath,
		"worktrees",
		path.basename(opts.worktreePath),
	);
	try {
		mkdirSync(adminDir, { recursive: true });
		mkdirSync(opts.worktreePath, { recursive: true });
		writeFileSync(
			path.join(opts.worktreePath, ".git"),
			`gitdir: ${adminDir}\n`,
		);
		writeFileSync(
			path.join(adminDir, "gitdir"),
			path.join(opts.worktreePath, ".git"),
		);
		writeFileSync(
			path.join(adminDir, "HEAD"),
			`ref: refs/heads/${opts.branchName}\n`,
		);
		// Two levels up from <repoPath>/worktrees/<id> is the bare repo whose
		// objects/refs this worktree shares.
		writeFileSync(path.join(adminDir, "commondir"), "../..");
	} catch (err) {
		// Leave nothing half-registered behind.
		rmSync(opts.worktreePath, { recursive: true, force: true });
		rmSync(adminDir, { recursive: true, force: true });
		const e = err as { message?: string };
		throw new Error(
			`orphan worktree registration failed: ${e.message ?? String(err)}`,
		);
	}
}

/**
 * Remove a Worktree and its branch, best-effort at every step — this runs
 * both as `delete`'s normal path and as `create`'s rollback after a failed
 * row insert, and in neither case may a git failure be what surfaces to the
 * caller. Falls back to an `rm -rf` plus `worktree prune` when git refuses,
 * and tolerates an already-deleted branch.
 *
 * `repoPath` is null when the Repo row is gone (deleted out from under the
 * Session) — there's no git dir left to run against, so only the directory
 * removal applies.
 */
export async function removeWorktree(opts: {
	repoPath: string | null;
	worktreePath: string;
	branchName: string;
}): Promise<void> {
	if (!opts.repoPath) {
		rmSync(opts.worktreePath, { recursive: true, force: true });
		return;
	}
	try {
		await git(["worktree", "remove", "--force", opts.worktreePath], {
			cwd: opts.repoPath,
		});
	} catch {
		rmSync(opts.worktreePath, { recursive: true, force: true });
		try {
			await git(["worktree", "prune"], { cwd: opts.repoPath });
		} catch {
			// ignore
		}
	}
	try {
		await git(["branch", "-D", opts.branchName], { cwd: opts.repoPath });
	} catch {
		// branch may already be gone (or never created, on the rollback path)
	}
}

/**
 * Most recent commits reachable from the Worktree's HEAD (its own commits
 * first, then inherited default-branch history), for the context panel.
 * Read live from git — never persisted. Soft-fails to [] (e.g. worktree
 * deleted out from under the session).
 */
export async function recentCommits(
	worktreePath: string,
	limit: number,
): Promise<CommitInfo[]> {
	try {
		const { stdout } = await git(
			["log", `-${limit}`, "--format=%h%x1f%s%x1f%at"],
			{ cwd: worktreePath },
		);
		return stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [hash = "", subject = "", at = ""] = line.split("\x1f");
				return { hash, subject, authoredAt: Number.parseInt(at, 10) || 0 };
			});
	} catch {
		return [];
	}
}

/**
 * Best-effort `codegraph init --yes` against a freshly created Worktree
 * (see Dockerfile's `codegraph` install comment for why this is a plain CLI
 * call, not an MCP wire-up). Failure — binary missing, unsupported repo,
 * whatever — never blocks Session creation; it just means `startPi` won't
 * find a `.codegraph/` dir and skips the codegraph note in the system
 * prompt. Runs once per Worktree, not once per Repo: each Worktree checks
 * out its own branch, and the graph is derived from that checkout's files.
 */
export async function initCodegraph(worktreePath: string): Promise<void> {
	try {
		await execFileAsync("codegraph", ["init", "--yes"], {
			cwd: worktreePath,
			maxBuffer: 50 * 1024 * 1024,
		});
	} catch (err) {
		log.error(
			{ worktreePath, err },
			"codegraph init failed (continuing without it)",
		);
	}
}
