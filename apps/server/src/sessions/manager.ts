import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
	AgentStreamEvent,
	AgentType,
	Message,
	MessagePart,
	Session,
	SessionView,
} from "@dilna/shared";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
	chatOpencode,
	type OpencodeHandle,
	startOpencode,
} from "../agents/opencode";
import { IDLE_TIMEOUT_MS } from "../agents/types";
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
		agentType: row.agentType as AgentType,
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

/**
 * Convert an opencode part payload (from `client.session.messages`) into a
 * dilna normalized {@link MessagePart}. Returns null for part types dilna
 * doesn't surface (step-start, reasoning, snapshot, patch, agent, etc.).
 */
function opencodePartToDilna(
	part: Record<string, unknown>,
): MessagePart | null {
	const type = part.type as string;
	if (type === "text") {
		const text = (part.text as string) ?? "";
		if (!text) return null;
		return { type: "text", text };
	}
	if (type === "tool") {
		const callId = (part.callID as string) ?? "";
		const tool = (part.tool as string) ?? "unknown";
		const state = (part.state as Record<string, unknown>) ?? {};
		const input = state.input ?? {};
		const status = (state.status as string) ?? "pending";
		if (status === "completed") {
			return {
				type: "tool_call",
				callId,
				tool,
				input,
				output: (state.output as string) ?? "",
			};
		}
		if (status === "error") {
			const err = (state.error as string) ?? "unknown error";
			return {
				type: "tool_call",
				callId,
				tool,
				input,
				output: err,
				error: err,
			};
		}
		return {
			type: "tool_call",
			callId,
			tool,
			input,
			output: "",
		};
	}
	return null;
}

type Listener = (event: AgentStreamEvent) => void;

type ActiveAgent = {
	handle: OpencodeHandle;
	chatInProgress: boolean;
	idleTimer: NodeJS.Timeout | null;
};

class SessionManager {
	/** Map of active dilna session id -> running agent process. */
	private active = new Map<string, ActiveAgent>();
	/** Map of dilna session id -> SSE subscribers (browser tabs etc). Kept
	 * independent of the agent lifecycle so a UI tab can subscribe before
	 * any agent is running and still receive events once it starts. */
	private subscribers = new Map<string, Set<Listener>>();

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
		// Kill any running agent first.
		await this.stopSession(id);

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
				// branch may already be gone
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

	async resetAllToIdle(): Promise<void> {
		const db = getDb();
		for (const s of ["working", "starting", "stopping"] as const) {
			db.update(sessionsTable)
				.set({ status: "idle" })
				.where(eq(sessionsTable.status, s))
				.run();
		}
	}

	// ---- Agent lifecycle ----------------------------------------------------

	/**
	 * Register a listener to receive events for the session. The listener
	 * fires for every normalized StreamEvent broadcast while the subscriber
	 * is registered.
	 */
	subscribe(id: string, listener: Listener): () => void {
		if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
		this.subscribers.get(id)?.add(listener);
		// No active agent → emit one idle status so the UI can settle.
		if (!this.active.has(id)) {
			listener({ type: "session_status", status: "idle" });
		}
		return () => {
			this.subscribers.get(id)?.delete(listener);
		};
	}

	async getMessages(id: string): Promise<Message[]> {
		const db = getDb();
		const rows = db
			.select()
			.from(messagesTable)
			.where(eq(messagesTable.sessionId, id))
			.orderBy(asc(messagesTable.createdAt))
			.all();
		return rows.map((row) => ({
			id: row.id,
			sessionId: row.sessionId,
			role: row.role as Message["role"],
			parts: JSON.parse(row.partsJson) as MessagePart[],
			createdAt: row.createdAt,
		}));
	}

	/**
	 * Send a user message to the session's agent. Spawns the agent process
	 * if it isn't running. Returns when the agent goes idle (chat complete).
	 *
	 * Live events are broadcast to subscribers as they arrive. The persisted
	 * message rows are written on completion (the user message immediately,
	 * the assistant message by fetching from opencode's session at the end).
	 * This avoids placeholder-spam and keeps the resume-render coherent with
	 * the live-stream view since both reference opencode's message IDs.
	 */
	async sendMessage(id: string, text: string): Promise<void> {
		const session = await this.get(id);
		if (!session) throw new Error("session not found");

		const active = await this.ensureStarted(id, session);
		if (active.chatInProgress) {
			throw new Error("session already has a chat in progress");
		}
		active.chatInProgress = true;
		this.clearIdleTimer(active);
		await this.setStatus(id, "working");

		const handle = active.handle;
		const onEvent = (ev: AgentStreamEvent) => this.broadcast(id, ev);

		const crashHandler: Listener = (ev) => {
			if (ev.type === "agent_crashed") {
				this.broadcast(id, ev);
				this.markCrashed(id);
			}
		};
		active.handle.listeners.add(crashHandler);

		try {
			await chatOpencode(handle, { message: text, onEvent });
		} finally {
			active.handle.listeners.delete(crashHandler);
			active.chatInProgress = false;

			// Persist everything we don't already have from opencode.
			await this.persistMessagesFromOpencode(id, handle);

			// Best-effort: if opencode auto-generated a title, sync it.
			this.maybeSyncTitle(id, handle).catch(() => {});

			await this.setStatus(id, "idle");
			this.armIdleTimer(id, active);
		}
	}

	/**
	 * Fetch the current message list from the opencode session and persist
	 * any messages dilna doesn't already have. Maps each part into dilna's
	 * normalized MessagePart shape.
	 */
	private async persistMessagesFromOpencode(
		sessionId: string,
		handle: OpencodeHandle,
	): Promise<void> {
		let msgs: unknown[];
		try {
			const res = await handle.client.session.messages({
				path: { id: handle.agentSessionId },
				throwOnError: true,
			});
			msgs = (res.data ?? []) as unknown[];
		} catch (err) {
			console.error("[sessions] failed to fetch messages from opencode:", err);
			return;
		}

		const existing = new Set(
			(await this.getMessages(sessionId)).map((m) => m.id),
		);
		for (const entry of msgs) {
			const e = entry as {
				info: {
					id: string;
					role: "user" | "assistant";
					time?: { created?: number };
				};
				parts: Array<Record<string, unknown>>;
			};
			const info = e.info;
			if (!info || !e.parts) continue;
			if (existing.has(info.id)) continue;
			const parts: MessagePart[] = [];
			for (const part of e.parts) {
				const norm = opencodePartToDilna(part);
				if (norm) parts.push(norm);
			}
			if (parts.length === 0) continue;
			const createdAt = Math.floor((info.time?.created ?? Date.now()) / 1000);
			const msg: Message = {
				id: info.id,
				sessionId,
				role: info.role,
				parts,
				createdAt,
			};
			this.persistMessage(sessionId, msg);
		}
	}

	/**
	 * Hard-stop the underlying agent process for a session. Broadcasts a
	 * session_status:idle event so subscribers can settle.
	 */
	async stopSession(id: string): Promise<void> {
		const active = this.active.get(id);
		if (!active) return;
		this.clearIdleTimer(active);
		this.active.delete(id);
		try {
			await active.handle.stop();
		} catch {
			// already gone
		}
		this.broadcast(id, { type: "session_status", status: "idle" });
		await this.setStatus(id, "idle");
	}

	private async ensureStarted(
		id: string,
		session: Session,
	): Promise<ActiveAgent> {
		const existing = this.active.get(id);
		if (existing?.handle.isAlive()) return existing;
		if (existing) this.active.delete(id);

		await this.setStatus(id, "starting");
		this.broadcast(id, { type: "session_status", status: "starting" });

		const handle = await startOpencode({
			worktreePath: session.worktreePath,
			existingAgentSessionId: session.agentSessionId ?? undefined,
		});

		// Persist the opencode session id so a later resume reconnects to the
		// same opencode session (cold-resume path per ADR-0003).
		const db = getDb();
		db.update(sessionsTable)
			.set({ agentSessionId: handle.agentSessionId })
			.where(eq(sessionsTable.id, id))
			.run();

		const active: ActiveAgent = {
			handle,
			chatInProgress: false,
			idleTimer: null,
		};
		this.active.set(id, active);
		await this.setStatus(id, "idle");
		this.broadcast(id, { type: "session_status", status: "idle" });
		return active;
	}

	private armIdleTimer(id: string, active: ActiveAgent) {
		this.clearIdleTimer(active);
		active.idleTimer = setTimeout(() => {
			void this.idleKill(id);
		}, IDLE_TIMEOUT_MS);
	}

	private clearIdleTimer(active: ActiveAgent) {
		if (active.idleTimer) {
			clearTimeout(active.idleTimer);
			active.idleTimer = null;
		}
	}

	private async idleKill(id: string) {
		const active = this.active.get(id);
		if (!active || active.chatInProgress) return;
		await this.stopSession(id);
	}

	private markCrashed(id: string) {
		const active = this.active.get(id);
		if (active) {
			this.clearIdleTimer(active);
			this.active.delete(id);
			void active.handle.stop().catch(() => {});
		}
		void this.setStatus(id, "crashed");
		this.broadcast(id, { type: "session_status", status: "crashed" });
	}

	private broadcast(id: string, event: AgentStreamEvent) {
		const subs = this.subscribers.get(id);
		if (!subs) return;
		for (const l of subs) {
			try {
				l(event);
			} catch {
				// listener errors during broadcast are non-fatal
			}
		}
	}

	private persistMessage(sessionId: string, message: Message): void {
		const db = getDb();
		db.insert(messagesTable)
			.values({
				id: message.id,
				sessionId,
				role: message.role,
				partsJson: JSON.stringify(message.parts),
				createdAt: message.createdAt,
			})
			.run();
	}

	private async maybeSyncTitle(
		id: string,
		handle: OpencodeHandle,
	): Promise<void> {
		try {
			const res = await handle.client.session.get({
				path: { id: handle.agentSessionId },
				throwOnError: true,
			});
			const summary = (res.data as { summary?: { title?: string } }).summary;
			if (summary?.title && summary.title !== "New session") {
				await this.setTitle(id, summary.title);
			}
		} catch {
			// title sync is best-effort
		}
	}
}

export const sessionManager = new SessionManager();
