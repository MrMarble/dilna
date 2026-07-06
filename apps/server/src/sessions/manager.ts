import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Session, SessionView } from "@dilna/shared";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "../db";
import {
	messages as messagesTable,
	sessions as sessionsTable,
} from "../db/schema";
import { repoManager } from "../repos/manager";

const execFileAsync = promisify(execFile);

async function git(args: string[], opts: { cwd?: string } = {}) {
	return execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });
}

function rowToSession(row: typeof sessionsTable.$inferSelect): Session {
	return {
		id: row.id,
		repoId: row.repoId,
		worktreePath: row.worktreePath,
		worktreeDirName: row.worktreeDirName,
		branchName: row.branchName,
		agentType: row.agentType as Session["agentType"],
		agentSessionId: row.agentSessionId,
		title: row.title,
		status: row.status as Session["status"],
		createdAt: row.createdAt,
		lastActiveAt: row.lastActiveAt,
	};
}

function toView(s: Session): SessionView {
	return {
		id: s.id,
		repoId: s.repoId,
		title: s.title,
		status: s.status,
		createdAt: s.createdAt,
		lastActiveAt: s.lastActiveAt,
	};
}

export class SessionManager {
	async listByRepo(repoId: string): Promise<SessionView[]> {
		const db = getDb();
		const rows = db
			.select()
			.from(sessionsTable)
			.where(eq(sessionsTable.repoId, repoId))
			.orderBy(asc(sessionsTable.lastActiveAt))
			.all();
		return rows.map(rowToSession).map(toView);
	}

	async get(id: string): Promise<Session | null> {
		const db = getDb();
		const row = db
			.select()
			.from(sessionsTable)
			.where(eq(sessionsTable.id, id))
			.get();
		return row ? rowToSession(row) : null;
	}

	async getView(id: string): Promise<SessionView | null> {
		const s = await this.get(id);
		return s ? toView(s) : null;
	}

	async create(repoId: string): Promise<SessionView> {
		const repo = await repoManager.get(repoId);
		if (!repo) throw new Error("repo not found");

		const id = nanoid();
		const branchName = `dilna/${id}`;
		const worktreeDirName = id;
		const worktreePath = path.join(
			repoManager.worktreeBase(repo.slug),
			worktreeDirName,
		);
		mkdirSync(path.dirname(worktreePath), { recursive: true });

		try {
			await git(
				[
					"worktree",
					"add",
					"-b",
					branchName,
					"--",
					worktreePath,
					repo.defaultBranch,
				],
				{ cwd: repo.path },
			);
		} catch (err) {
			const e = err as { stderr?: string; message?: string };
			throw new Error(
				`git worktree add failed: ${e.stderr?.trim() || e.message}`,
			);
		}

		const now = Math.floor(Date.now() / 1000);
		const session: Session = {
			id,
			repoId: repo.id,
			worktreePath,
			worktreeDirName,
			branchName,
			agentType: "opencode",
			agentSessionId: null,
			title: "New session",
			status: "idle",
			createdAt: now,
			lastActiveAt: now,
		};

		const db = getDb();
		db.insert(sessionsTable)
			.values({
				id: session.id,
				repoId: session.repoId,
				worktreePath: session.worktreePath,
				worktreeDirName: session.worktreeDirName,
				branchName: session.branchName,
				agentType: session.agentType,
				agentSessionId: session.agentSessionId,
				title: session.title,
				status: session.status,
				createdAt: session.createdAt,
				lastActiveAt: session.lastActiveAt,
			})
			.run();

		return toView(session);
	}

	async delete(id: string): Promise<void> {
		const session = await this.get(id);
		if (!session) return;
		const repo = await repoManager.get(session.repoId);
		const db = getDb();

		if (repo) {
			try {
				await git(["worktree", "remove", "--force", session.worktreePath], {
					cwd: repo.path,
				});
			} catch {
				rmSync(session.worktreePath, { recursive: true, force: true });
				try {
					await git(["worktree", "prune"], { cwd: repo.path });
				} catch {
					// ignore
				}
			}
			try {
				await git(["branch", "-D", session.branchName], { cwd: repo.path });
			} catch {
				// branch may already be gone; ignore
			}
		} else {
			rmSync(session.worktreePath, { recursive: true, force: true });
		}

		db.delete(messagesTable).where(eq(messagesTable.sessionId, id)).run();
		db.delete(sessionsTable).where(eq(sessionsTable.id, id)).run();
	}

	async touch(id: string): Promise<void> {
		const db = getDb();
		const now = Math.floor(Date.now() / 1000);
		db.update(sessionsTable)
			.set({ lastActiveAt: now })
			.where(eq(sessionsTable.id, id))
			.run();
	}

	async setTitle(id: string, title: string): Promise<void> {
		const db = getDb();
		db.update(sessionsTable)
			.set({ title })
			.where(eq(sessionsTable.id, id))
			.run();
	}

	async setStatus(id: string, status: Session["status"]): Promise<void> {
		const db = getDb();
		const now = Math.floor(Date.now() / 1000);
		db.update(sessionsTable)
			.set({ status, lastActiveAt: now })
			.where(eq(sessionsTable.id, id))
			.run();
	}

	/** Reset every non-idle session to idle. Called on server boot. */
	async resetAllToIdle(): Promise<void> {
		const db = getDb();
		db.update(sessionsTable)
			.set({ status: "idle" })
			.where(eq(sessionsTable.status, "working"))
			.run();
		db.update(sessionsTable)
			.set({ status: "idle" })
			.where(eq(sessionsTable.status, "starting"))
			.run();
		db.update(sessionsTable)
			.set({ status: "idle" })
			.where(eq(sessionsTable.status, "stopping"))
			.run();
	}
}

export const sessionManager = new SessionManager();
