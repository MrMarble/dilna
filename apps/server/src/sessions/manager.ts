import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as setTimeoutAsync } from "node:timers/promises";
import { promisify } from "node:util";
import {
	getSessionInfo,
	getSessionMessages,
	type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
import { type ClaudeHandle, chatClaude, startClaude } from "../agents/claude";
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

type ClaudeContentBlock = Record<string, unknown> & { type?: string };

/**
 * Extract the plain-text portion of a Claude message-param `content` field,
 * which may be a bare string or an array of content blocks.
 */
function claudeContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as ClaudeContentBlock[])
			.filter((b) => b.type === "text")
			.map((b) => (b.text as string) ?? "")
			.join("");
	}
	return "";
}

/**
 * Convert Claude Agent SDK transcript entries (from `getSessionMessages`)
 * into dilna normalized {@link Message} rows.
 *
 * Claude starts a brand-new SDKAssistantMessage (a new uuid) after every
 * tool round-trip within a single turn, unlike opencode which keeps one
 * message id for the whole turn. All assistant entries between one real
 * user message and the next are merged into a single Message row here —
 * id'd by the *first* assistant entry's uuid — so persisted history has the
 * same one-row-per-turn granularity as the live view (see the matching
 * `currentTurnMessageId` merge in `agents/claude.ts`'s event normalizer;
 * `fetchClaudeMessagesWithRetry`'s `expectedMessageId` gate depends on both
 * sides picking the same id for a turn).
 *
 * Tool results arrive as separate synthetic user-role transcript entries;
 * they're merged back into the owning tool_call part (matching opencode's
 * merged pending/completed tool state) rather than persisted as their own
 * row. Real (non-tool-result) user entries are persisted as their own text
 * messages and also flush any in-progress assistant turn.
 *
 * Claude's transcript entries carry no timestamp, so createdAt is
 * synthesized as `now + index` to preserve transcript order across a batch.
 */
function claudeMessagesToDilna(
	sessionId: string,
	raw: SessionMessage[],
): Message[] {
	const toolResults = new Map<string, { output: string; error?: string }>();
	for (const entry of raw) {
		if (entry.type !== "user") continue;
		const content = (entry.message as { content?: unknown })?.content;
		const blocks = Array.isArray(content)
			? (content as ClaudeContentBlock[])
			: [];
		for (const block of blocks) {
			if (block.type !== "tool_result") continue;
			const callId = block.tool_use_id as string;
			const isError = block.is_error === true;
			const output = claudeContentToText(block.content);
			toolResults.set(callId, { output, error: isError ? output : undefined });
		}
	}

	const baseCreatedAt = Math.floor(Date.now() / 1000);
	const messages: Message[] = [];
	let turn: { id: string; createdAt: number; parts: MessagePart[] } | null =
		null;
	const flushTurn = () => {
		if (turn && turn.parts.length > 0) {
			messages.push({
				id: turn.id,
				sessionId,
				role: "assistant",
				parts: turn.parts,
				createdAt: turn.createdAt,
			});
		}
		turn = null;
	};

	raw.forEach((entry, index) => {
		const createdAt = baseCreatedAt + index;
		const content = (entry.message as { content?: unknown })?.content;
		const blocks = Array.isArray(content)
			? (content as ClaudeContentBlock[])
			: [];

		if (entry.type === "assistant") {
			if (!turn) turn = { id: entry.uuid, createdAt, parts: [] };
			for (const block of blocks) {
				if (block.type === "text") {
					const text = (block.text as string) ?? "";
					if (text) turn.parts.push({ type: "text", text });
				} else if (block.type === "tool_use") {
					const callId = block.id as string;
					const result = toolResults.get(callId);
					turn.parts.push({
						type: "tool_call",
						callId,
						tool: (block.name as string) ?? "unknown",
						input: block.input ?? {},
						output: result?.output ?? "",
						error: result?.error,
					});
				}
			}
		} else if (entry.type === "user") {
			const isSynthetic = blocks.some((b) => b.type === "tool_result");
			if (isSynthetic) return;
			// A real user message ends any in-progress assistant turn.
			flushTurn();
			const text = claudeContentToText(content);
			if (text) {
				messages.push({
					id: entry.uuid,
					sessionId,
					role: "user",
					parts: [{ type: "text", text }],
					createdAt,
				});
			}
		}
	});
	flushTurn();
	return messages;
}

type Listener = (event: AgentStreamEvent) => void;

type ActiveAgent = {
	handle: OpencodeHandle | ClaudeHandle;
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

	async create(
		repoId: string,
		agentType: AgentType = "opencode",
	): Promise<SessionView> {
		if (agentType === "openai") {
			throw new Error("openai agent backend is not implemented yet");
		}
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
			agentType,
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

		let expectedClaudeMessageId: string | undefined;
		try {
			if (handle.kind === "claude") {
				expectedClaudeMessageId = await chatClaude(handle, {
					message: text,
					onEvent,
				});
			} else {
				await chatOpencode(handle, { message: text, onEvent });
			}
		} finally {
			active.handle.listeners.delete(crashHandler);
			active.chatInProgress = false;

			// Claude's agentSessionId is unknown until the first turn's init
			// message arrives (see claude.ts), so re-sync it post-chat — a
			// no-op for opencode, whose id is already known at start time.
			if (handle.agentSessionId) {
				const db = getDb();
				db.update(sessionsTable)
					.set({ agentSessionId: handle.agentSessionId })
					.where(eq(sessionsTable.id, id))
					.run();
			}

			// Persist everything we don't already have from the agent backend.
			await this.persistMessagesFromAgent(id, handle, expectedClaudeMessageId);

			// Best-effort: if the agent auto-generated a title, sync it.
			this.maybeSyncTitle(id, handle).catch(() => {});

			await this.setStatus(id, "idle");
			this.armIdleTimer(id, active);
		}
	}

	/**
	 * Fetch the current message list from the agent backend and persist any
	 * messages dilna doesn't already have. Maps each backend's native
	 * transcript shape into dilna's normalized MessagePart shape.
	 */
	private async persistMessagesFromAgent(
		sessionId: string,
		handle: OpencodeHandle | ClaudeHandle,
		expectedClaudeMessageId?: string,
	): Promise<void> {
		const existing = new Set(
			(await this.getMessages(sessionId)).map((m) => m.id),
		);

		if (handle.kind === "claude") {
			if (!handle.agentSessionId) return;
			const converted = await this.fetchClaudeMessagesWithRetry(
				sessionId,
				handle,
				expectedClaudeMessageId,
			);
			for (const msg of converted) {
				if (existing.has(msg.id)) continue;
				this.persistMessage(sessionId, msg);
			}
			return;
		}

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
	 * `getSessionMessages` reads Claude's own JSONL transcript file, which
	 * can lag behind the live event stream: the `result` event that resolves
	 * {@link chatClaude} doesn't guarantee the transcript write for that same
	 * turn has landed on disk yet.
	 *
	 * Gating the retry on "does the expected message id merely appear" is
	 * not enough on its own: because `claudeMessagesToDilna` merges every
	 * assistant round of a turn into one row keyed by the *first* round's
	 * uuid (see that function's doc comment), that id can show up in the
	 * very first fetch — right after the first tool call round is written —
	 * long before later rounds (including the turn's final text reply) have
	 * been flushed. So this also requires the *raw* transcript to be stable
	 * (same length and same last entry) across two consecutive polls before
	 * accepting it, on top of the expected id being present at all.
	 *
	 * `expectedMessageId` is undefined for turns that produced no assistant
	 * message (aborted/errored) — in that case there's nothing turn-specific
	 * to wait for beyond stability.
	 */
	private async fetchClaudeMessagesWithRetry(
		sessionId: string,
		handle: ClaudeHandle,
		expectedMessageId: string | undefined,
	): Promise<Message[]> {
		const delaysMs = [0, 150, 300, 500, 800, 1200, 1500];
		let lastRaw: SessionMessage[] = [];
		let prevLength = -1;
		let prevLastUuid: string | undefined;
		for (let attempt = 0; attempt < delaysMs.length; attempt++) {
			if (attempt > 0) await setTimeoutAsync(delaysMs[attempt]);
			try {
				lastRaw = await getSessionMessages(handle.agentSessionId, {
					dir: handle.worktreePath,
				});
			} catch (err) {
				console.error(
					"[sessions] failed to fetch messages from claude agent:",
					err,
				);
				return claudeMessagesToDilna(sessionId, lastRaw);
			}
			const lastUuid = lastRaw.at(-1)?.uuid;
			const hasExpected =
				!expectedMessageId || lastRaw.some((e) => e.uuid === expectedMessageId);
			const stable = lastRaw.length === prevLength && lastUuid === prevLastUuid;
			if (hasExpected && stable)
				return claudeMessagesToDilna(sessionId, lastRaw);
			prevLength = lastRaw.length;
			prevLastUuid = lastUuid;
		}
		console.error(
			`[sessions] claude transcript for ${sessionId} did not stabilize after retrying (expected message ${expectedMessageId})`,
		);
		return claudeMessagesToDilna(sessionId, lastRaw);
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

		if (session.agentType === "openai") {
			throw new Error("openai agent backend is not implemented yet");
		}
		const startOpts = {
			worktreePath: session.worktreePath,
			existingAgentSessionId: session.agentSessionId ?? undefined,
		};
		const handle: OpencodeHandle | ClaudeHandle =
			session.agentType === "claude"
				? await startClaude(startOpts)
				: await startOpencode(startOpts);

		// Persist the agent's own session id so a later resume reconnects to
		// the same backend session (cold-resume path per ADR-0003).
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
		handle: OpencodeHandle | ClaudeHandle,
	): Promise<void> {
		try {
			if (handle.kind === "claude") {
				if (!handle.agentSessionId) return;
				const info = await getSessionInfo(handle.agentSessionId, {
					dir: handle.worktreePath,
				});
				if (info?.summary) {
					await this.setTitle(id, info.summary);
				}
				return;
			}
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
