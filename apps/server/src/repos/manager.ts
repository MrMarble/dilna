import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Repo } from "@dilna/shared";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDataDir, getDb } from "../db";
import { repos as reposTable } from "../db/schema";

const execFileAsync = promisify(execFile);

async function git(args: string[], opts: { cwd?: string } = {}) {
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
		return rows.map(rowToRepo);
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

	async delete(id: string): Promise<void> {
		const repo = await this.get(id);
		if (!repo) return;
		const db = getDb();

		const wtBase = this.worktreeBase(repo.slug);
		try {
			await git(["worktree", "prune"], { cwd: repo.path });
		} catch {
			// ignore
		}
		rmSync(wtBase, { recursive: true, force: true });
		rmSync(repo.path, { recursive: true, force: true });
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
