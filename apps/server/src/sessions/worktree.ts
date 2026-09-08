import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
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
 */
export async function createWorktree(opts: {
	repoPath: string;
	worktreePath: string;
	branchName: string;
	baseBranch: string;
}): Promise<void> {
	mkdirSync(path.dirname(opts.worktreePath), { recursive: true });
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
