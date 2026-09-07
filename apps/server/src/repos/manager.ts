import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Repo, RepoStats, RepoSyncStatus } from "@dilna/shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDataDir, getDb } from "../db";
import {
	repoMemory as repoMemoryTable,
	repos as reposTable,
} from "../db/schema";
// Cyclical with sessions/manager.ts (which imports `repoManager` from this
// file) — safe here because both sides only reach for the other singleton
// from inside async method bodies, never at module-evaluation time.
import { sessionManager } from "../sessions/manager";
import { languagesFromFiles, type TreeFile } from "./languages";

const execFileAsync = promisify(execFile);

async function git(
	args: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
	return execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });
}

function deriveSlug(url: string): string {
	let s = url.replace(/\.git$/, "");
	if (s.includes(":") && !s.startsWith("http")) {
		s = (s.split(":").pop() ?? s).trim();
	} else {
		s = (s.split("/").pop() ?? s).trim();
	}
	s = s
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "repo";
}

async function getDefaultBranch(barePath: string): Promise<string> {
	try {
		const { stdout } = await git(["symbolic-ref", "HEAD"], { cwd: barePath });
		const ref = stdout.trim();
		return ref.replace(/^refs\/heads\//, "");
	} catch {
		try {
			const { stdout } = await git(["rev-parse", "HEAD"], { cwd: barePath });
			return stdout.trim();
		} catch {
			return "main";
		}
	}
}

function uniqueSlug(used: Set<string>, base: string): string {
	if (!used.has(base)) return base;
	let i = 2;
	while (used.has(`${base}-${i}`)) i++;
	return `${base}-${i}`;
}

/**
 * Reserved slug for the orchestrator meta-repo (ADR-0021) — a local
 * `git init --bare` repo dilna creates for itself purely so an orchestrator
 * Session can go through the exact same Worktree-creation path as any other
 * Session, with no worktree/repoId nullability ripple through `Session`/
 * `SessionView`. Never a real clone, never a valid `repoId` for
 * `dilna_create_session`'s target. `list()` filters it out so it never
 * reaches `GET /api/repos`, the sidebar, or the orchestrator's own
 * `dilna_list_repos` tool.
 */
export const ORCHESTRATOR_REPO_SLUG = "_dilna-orchestrator";

/** Distinguished from a generic thrown Error so callers (e.g.
 * SessionManager.create, routes/sessions.ts) can map it to its own HTTP
 * status (404) instead of a message-string catch-all. */
export class RepoNotFoundError extends Error {
	constructor(id: string) {
		super(`repo not found: ${id}`);
		this.name = "RepoNotFoundError";
	}
}

export class RepoManager {
	get reposDir(): string {
		return path.join(getDataDir(), "repos");
	}

	get worktreesDir(): string {
		return path.join(getDataDir(), "worktrees");
	}

	repoPath(slug: string): string {
		return path.join(this.reposDir, slug);
	}

	worktreeBase(slug: string): string {
		return path.join(this.worktreesDir, slug);
	}

	async list(): Promise<Repo[]> {
		const db = getDb();
		const rows = db.select().from(reposTable).all();
		return rows.map(rowToRepo).filter((r) => r.slug !== ORCHESTRATOR_REPO_SLUG);
	}

	async get(id: string): Promise<Repo | null> {
		const db = getDb();
		const row = db.select().from(reposTable).where(eq(reposTable.id, id)).get();
		return row ? rowToRepo(row) : null;
	}

	async getBySlug(slug: string): Promise<Repo | null> {
		const db = getDb();
		const row = db
			.select()
			.from(reposTable)
			.where(eq(reposTable.slug, slug))
			.get();
		return row ? rowToRepo(row) : null;
	}

	async clone(url: string, requestedSlug?: string): Promise<Repo> {
		url = url.trim();
		if (!url) throw new Error("URL is required");

		const baseSlug = deriveSlug(requestedSlug?.trim() || url);
		const existing = await this.list();
		const usedSlugs = new Set(existing.map((r) => r.slug));
		const slug = uniqueSlug(usedSlugs, baseSlug);
		const repoPath = this.repoPath(slug);

		mkdirSync(this.reposDir, { recursive: true });
		mkdirSync(this.worktreesDir, { recursive: true });
		try {
			await git(["clone", "--bare", "--", url, repoPath]);
		} catch (err) {
			const e = err as { stderr?: string; message?: string };
			throw new Error(
				`git clone failed for ${url}: ${e.stderr?.trim() || e.message}`,
			);
		}
		await this.ensureGitDefaults(repoPath);

		let defaultBranch: string;
		try {
			defaultBranch = await getDefaultBranch(repoPath);
		} catch {
			defaultBranch = "main";
		}

		const now = Math.floor(Date.now() / 1000);
		const repo: Repo = {
			id: nanoid(),
			slug,
			path: repoPath,
			defaultBranch,
			remoteUrl: url,
			createdAt: now,
		};

		const db = getDb();
		db.insert(reposTable)
			.values({
				id: repo.id,
				slug: repo.slug,
				path: repo.path,
				defaultBranch: repo.defaultBranch,
				remoteUrl: repo.remoteUrl,
				createdAt: repo.createdAt,
			})
			.run();

		return repo;
	}

	/**
	 * Idempotent: creates the orchestrator meta-repo (see
	 * {@link ORCHESTRATOR_REPO_SLUG}) on first call, returns the existing row
	 * on every call after. Unlike `clone()`, there's no remote to clone from —
	 * `git init --bare` plus a plumbed-in empty root commit (no worktree
	 * needed to create one: `hash-object`/`commit-tree`/`update-ref` write
	 * directly into the bare repo's object store) gives `defaultBranch` a
	 * real ref to branch Sessions' Worktrees off of, matching what
	 * `SessionManager.create`'s `git worktree add -b <branch> -- <path>
	 * <defaultBranch>` requires.
	 */
	async ensureOrchestratorRepo(): Promise<Repo> {
		const existing = await this.getBySlug(ORCHESTRATOR_REPO_SLUG);
		if (existing) return existing;

		const repoPath = this.repoPath(ORCHESTRATOR_REPO_SLUG);
		mkdirSync(this.reposDir, { recursive: true });
		mkdirSync(this.worktreesDir, { recursive: true });
		await git(["init", "--bare", "--initial-branch=main", "--", repoPath]);
		await this.ensureGitDefaults(repoPath);

		const { stdout: emptyTree } = await git(
			["hash-object", "-t", "tree", "/dev/null"],
			{ cwd: repoPath },
		);
		// A sentinel identity, not read from ambient git config — this is an
		// internal plumbing commit with no meaningful author, and the host
		// running dilna may have no global user.name/user.email configured at
		// all (git requires one to commit).
		const { stdout: commit } = await git(
			["commit-tree", emptyTree.trim(), "-m", "orchestrator meta-repo"],
			{
				cwd: repoPath,
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "dilna",
					GIT_AUTHOR_EMAIL: "dilna@localhost",
					GIT_COMMITTER_NAME: "dilna",
					GIT_COMMITTER_EMAIL: "dilna@localhost",
				},
			},
		);
		await git(["update-ref", "refs/heads/main", commit.trim()], {
			cwd: repoPath,
		});

		const now = Math.floor(Date.now() / 1000);
		const repo: Repo = {
			id: nanoid(),
			slug: ORCHESTRATOR_REPO_SLUG,
			path: repoPath,
			defaultBranch: "main",
			remoteUrl: "",
			createdAt: now,
		};
		const db = getDb();
		db.insert(reposTable)
			.values({
				id: repo.id,
				slug: repo.slug,
				path: repo.path,
				defaultBranch: repo.defaultBranch,
				remoteUrl: repo.remoteUrl,
				createdAt: repo.createdAt,
			})
			.run();
		return repo;
	}

	/**
	 * Make the bare repo's shared git state behave like a normal clone's for
	 * every Session worktree hanging off it. Idempotent; run at clone and at
	 * boot (see index.ts) to backfill repos cloned before these fixes.
	 *
	 * 1. Fetch refspec: `git clone --bare` leaves `remote.origin.fetch`
	 *    unset (a normal clone sets `+refs/heads/*:refs/remotes/origin/*`),
	 *    and every worktree shares the bare repo's config. Without the
	 *    refspec, git inside a worktree misbehaves in cascading ways:
	 *    `git fetch origin <branch>` updates only `FETCH_HEAD` (never
	 *    `refs/remotes/origin/*`, so a stale tracking ref looks like
	 *    divergence), `@{u}` can never resolve — even when a same-named
	 *    tracking ref exists on disk, because upstream resolution maps
	 *    `branch.<name>.merge` *through* the refspec — and `gh pr create`
	 *    falsely reports the branch as never pushed.
	 *
	 * 2. Exclude `.gitmodules`: Claude Code's sandbox hardening pre-creates
	 *    an empty `.gitmodules` at the agent's cwd (a bind-mount target it
	 *    read-denies inside the sandbox, so a repo can't smuggle submodule
	 *    config into an auto-approved session) and hides it by appending to
	 *    `<cwd>/.git/info/exclude` — but in a linked worktree `.git` is a
	 *    file, so that append silently fails and the stray file shows up
	 *    untracked in every Session's `git status`. `info/exclude` follows
	 *    the common-dir rule (linked worktrees read the *bare repo's* copy,
	 *    not a per-worktree one), so writing it here covers all Sessions.
	 *    Only `.gitmodules` — the other files the sandbox touches
	 *    (package.json, lockfiles, …) are ones an agent may legitimately
	 *    create, and excluding those would hide real work from `git status`.
	 */
	private async ensureGitDefaults(repoPath: string): Promise<void> {
		await git(
			[
				"config",
				"--replace-all",
				"remote.origin.fetch",
				"+refs/heads/*:refs/remotes/origin/*",
			],
			{ cwd: repoPath },
		);

		const excludePath = path.join(repoPath, "info", "exclude");
		let existing = "";
		try {
			existing = readFileSync(excludePath, "utf8");
		} catch {
			// missing info/exclude — created below
		}
		if (!existing.split("\n").includes(".gitmodules")) {
			mkdirSync(path.dirname(excludePath), { recursive: true });
			appendFileSync(excludePath, ".gitmodules\n");
		}
	}

	/** Backfill `ensureGitDefaults` across all existing Repos. */
	async ensureAllGitDefaults(): Promise<void> {
		for (const repo of await this.list()) {
			try {
				await this.ensureGitDefaults(repo.path);
			} catch (err) {
				console.warn(
					`[repos] failed to apply git defaults for ${repo.slug}:`,
					err,
				);
			}
		}
	}

	/**
	 * Fetch the Repo's default branch from its `origin` remote into the bare
	 * clone, so new Sessions (which branch off `defaultBranch` — see
	 * `SessionManager.create`) start from up-to-date history. The configured
	 * fetch refspec (see `ensureFetchRefspec`) only maintains
	 * `refs/remotes/origin/*`, while worktree creation branches off the
	 * *local* `refs/heads/<defaultBranch>` — so this fetches `defaultBranch`
	 * explicitly into the same-named local ref, scoped to that one branch so
	 * Sessions' own `dilna/<id>` branches living in the same bare repo are
	 * never touched by this call.
	 */
	async pull(repo: Repo): Promise<void> {
		try {
			await git(
				[
					"fetch",
					"origin",
					`+refs/heads/${repo.defaultBranch}:refs/heads/${repo.defaultBranch}`,
				],
				{ cwd: repo.path },
			);
		} catch (err) {
			const e = err as { stderr?: string; message?: string };
			throw new Error(
				`git fetch failed for ${repo.slug}: ${e.stderr?.trim() || e.message}`,
			);
		}
	}

	/**
	 * How far the bare clone's local `defaultBranch` ref has drifted from
	 * `origin`'s, for the sidebar's periodic "N to pull" badge. Unlike `pull`,
	 * this only updates `refs/remotes/origin/<defaultBranch>` — the local ref
	 * is left untouched — so it's safe to call on a timer purely to check
	 * what's new upstream without changing what any Session branches off of.
	 */
	async syncStatus(repo: Repo): Promise<RepoSyncStatus> {
		try {
			await git(
				[
					"fetch",
					"origin",
					`+refs/heads/${repo.defaultBranch}:refs/remotes/origin/${repo.defaultBranch}`,
				],
				{ cwd: repo.path },
			);
		} catch (err) {
			const e = err as { stderr?: string; message?: string };
			throw new Error(
				`git fetch failed for ${repo.slug}: ${e.stderr?.trim() || e.message}`,
			);
		}
		const { stdout } = await git(
			[
				"rev-list",
				"--left-right",
				"--count",
				`refs/heads/${repo.defaultBranch}...refs/remotes/origin/${repo.defaultBranch}`,
			],
			{ cwd: repo.path },
		);
		const [ahead, behind] = stdout
			.trim()
			.split(/\s+/)
			.map((n) => Number.parseInt(n, 10) || 0);
		return { ahead: ahead ?? 0, behind: behind ?? 0 };
	}

	/**
	 * File count and language breakdown for the Repo's default branch,
	 * computed from the bare clone's HEAD tree (`git ls-tree -r --long`) —
	 * no worktree involved, so it works for repos with no Sessions yet.
	 * Computed on demand rather than persisted: a few ms even on large trees,
	 * and it can never go stale after a pull.
	 */
	async stats(repo: Repo): Promise<RepoStats> {
		const { stdout } = await git(["ls-tree", "-r", "--long", "HEAD"], {
			cwd: repo.path,
		});
		// Format per line: <mode> <type> <hash> <size>\t<path>
		const files: TreeFile[] = [];
		for (const line of stdout.split("\n")) {
			if (!line) continue;
			const tab = line.indexOf("\t");
			if (tab === -1) continue;
			const meta = line.slice(0, tab).trim().split(/\s+/);
			if (meta[1] !== "blob") continue;
			const size = Number.parseInt(meta[3] ?? "", 10);
			files.push({
				path: line.slice(tab + 1),
				size: Number.isNaN(size) ? 0 : size,
			});
		}
		return { fileCount: files.length, languages: languagesFromFiles(files) };
	}

	async delete(id: string): Promise<void> {
		const repo = await this.get(id);
		if (!repo) return;
		const db = getDb();

		// Stop and fully clean up every Session still pointing at this repo
		// before tearing down its worktrees/bare clone below — otherwise their
		// rows (and any still-running agent) are orphaned, pointing at a
		// worktree path that's about to stop existing. Reuses
		// SessionManager.delete's own stop/archive/git-cleanup/row-delete
		// rather than duplicating it here; its worktree/branch removal is
		// redundant with the wholesale rmSync below but harmless.
		for (const session of await sessionManager.listByRepo(id)) {
			await sessionManager.delete(session.id);
		}

		const wtBase = this.worktreeBase(repo.slug);
		try {
			await git(["worktree", "prune"], { cwd: repo.path });
		} catch {
			// ignore
		}
		rmSync(wtBase, { recursive: true, force: true });
		rmSync(repo.path, { recursive: true, force: true });
		db.delete(repoMemoryTable).where(eq(repoMemoryTable.repoId, id)).run();
		db.delete(reposTable).where(eq(reposTable.id, id)).run();
	}
}

function rowToRepo(row: typeof reposTable.$inferSelect): Repo {
	return {
		id: row.id,
		slug: row.slug,
		path: row.path,
		defaultBranch: row.defaultBranch,
		remoteUrl: row.remoteUrl,
		createdAt: row.createdAt,
	};
}

export const repoManager = new RepoManager();
