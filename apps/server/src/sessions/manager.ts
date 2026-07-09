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
	SessionListEvent,
	SessionView,
} from "@dilna/shared";
import { and, asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { type ClaudeHandle, chatClaude, startClaude } from "../agents/claude";
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
		agentType: s.agentType,
		status: s.status,
		createdAt: s.createdAt,
		lastActiveAt: s.lastActiveAt,
	};
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
 * tool round-trip within a single turn. All assistant entries between one
 * real user message and the next are merged into a single Message row here —
 * id'd by the *first* assistant entry's uuid — so persisted history has the
 * same one-row-per-turn granularity as the live view (see the matching
 * `currentTurnMessageId` merge in `agents/claude.ts`'s event normalizer;
 * `fetchClaudeMessagesWithRetry`'s `expectedMessageId` gate depends on both
 * sides picking the same id for a turn).
 *
 * Tool results arrive as separate synthetic user-role transcript entries;
 * they're merged back into the owning tool_call part rather than persisted
 * as their own row. Real (non-tool-result) user entries are persisted as
 * their own text messages and also flush any in-progress assistant turn.
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
	handle: ClaudeHandle;
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
	/** Cross-session status subscribers (per ADR-0008): one subscription per
	 * app load, notified on every status change of every session. */
	private globalSubscribers = new Set<(event: SessionListEvent) => void>();

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

	/** All sessions across every repo, for the cross-session status stream
	 * (per ADR-0008) to snapshot on subscribe. */
	async listAll(): Promise<SessionView[]> {
		const db = getDb();
		const rows = db
			.select()
			.from(sessionsTable)
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
		agentType: AgentType = "claude",
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
			// Distinguishable placeholder until the agent's own auto-derived
			// title lands (see maybeSyncTitle) — "New session" for every session
			// made every entry in the session dropdown indistinguishable until
			// the first message was sent.
			title: `Session ${id.slice(0, 4)}`,
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

		const view = toView(session);
		this.broadcastGlobal({ type: "session_status", session: view });
		return view;
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
		this.broadcastGlobal({ type: "session_deleted", sessionId: id });
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
		const view = await this.getView(id);
		if (view) this.broadcastGlobal({ type: "session_status", session: view });
	}

	async setStatus(id: string, status: Session["status"]): Promise<void> {
		const db = getDb();
		const now = Math.floor(Date.now() / 1000);
		db.update(sessionsTable)
			.set({ status, lastActiveAt: now })
			.where(eq(sessionsTable.id, id))
			.run();
		const view = await this.getView(id);
		if (view) this.broadcastGlobal({ type: "session_status", session: view });
	}

	async resetAllToIdle(): Promise<void> {
		const db = getDb();
		for (const s of ["working", "starting", "stopping"] as const) {
			const rows = db
				.select({ id: sessionsTable.id })
				.from(sessionsTable)
				.where(eq(sessionsTable.status, s))
				.all();
			for (const { id } of rows) {
				// Drop any pending-user placeholder left behind by a turn that
				// was interrupted by the server restart (see sendMessage).
				this.deleteMessage(id, this.pendingUserMessageId(id));
			}
			db.update(sessionsTable)
				.set({ status: "idle" })
				.where(eq(sessionsTable.status, s))
				.run();
		}
	}

	/**
	 * Register a listener to receive a SessionListEvent whenever any
	 * session's status changes, across every repo. Powers the sidebar's
	 * Background Agents panel and the chat header's session dropdown (per
	 * ADR-0008) without the caller subscribing to each session individually.
	 */
	subscribeAll(listener: (event: SessionListEvent) => void): () => void {
		this.globalSubscribers.add(listener);
		return () => {
			this.globalSubscribers.delete(listener);
		};
	}

	private broadcastGlobal(event: SessionListEvent) {
		for (const l of this.globalSubscribers) {
			try {
				l(event);
			} catch {
				// listener errors during broadcast are non-fatal
			}
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
	 * Live events are broadcast to subscribers as they arrive. The user's
	 * message is persisted immediately under a placeholder id (its content
	 * is already fully known — no reason to wait), so a page reload mid-turn
	 * still shows it instead of an empty history. The assistant's message is
	 * still only persisted at turn end (fetched from the agent backend,
	 * which assigns its own id), at which point the placeholder is dropped.
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
		this.persistMessage(id, {
			id: this.pendingUserMessageId(id),
			sessionId: id,
			role: "user",
			parts: [{ type: "text", text }],
			createdAt: Math.floor(Date.now() / 1000),
		});

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
			expectedClaudeMessageId = await chatClaude(handle, {
				message: text,
				onEvent,
			});
		} finally {
			active.handle.listeners.delete(crashHandler);
			active.chatInProgress = false;

			// Claude's agentSessionId is unknown until the first turn's init
			// message arrives (see claude.ts), so re-sync it post-chat.
			if (handle.agentSessionId) {
				const db = getDb();
				db.update(sessionsTable)
					.set({ agentSessionId: handle.agentSessionId })
					.where(eq(sessionsTable.id, id))
					.run();
			}

			// Persist everything we don't already have from the agent backend,
			// then drop the placeholder now that the authoritative row exists.
			await this.persistMessagesFromAgent(id, handle, expectedClaudeMessageId);
			this.deleteMessage(id, this.pendingUserMessageId(id));

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
		handle: ClaudeHandle,
		expectedClaudeMessageId?: string,
	): Promise<void> {
		if (!handle.agentSessionId) return;
		const existing = new Set(
			(await this.getMessages(sessionId)).map((m) => m.id),
		);
		const converted = await this.fetchClaudeMessagesWithRetry(
			sessionId,
			handle,
			expectedClaudeMessageId,
		);
		for (const msg of converted) {
			if (existing.has(msg.id)) continue;
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
		const handle: ClaudeHandle = await startClaude(startOpts);

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

	/** Stable id for the one-per-session placeholder row that stands in for
	 * the user's message while its turn is still in progress (see
	 * sendMessage). A session has at most one in-flight turn at a time, so
	 * this id never needs to be unique per-turn. */
	private pendingUserMessageId(sessionId: string): string {
		return `pending-user-${sessionId}`;
	}

	private deleteMessage(sessionId: string, messageId: string): void {
		const db = getDb();
		db.delete(messagesTable)
			.where(
				and(
					eq(messagesTable.sessionId, sessionId),
					eq(messagesTable.id, messageId),
				),
			)
			.run();
	}

	private async maybeSyncTitle(
		id: string,
		handle: ClaudeHandle,
	): Promise<void> {
		try {
			if (!handle.agentSessionId) return;
			const info = await getSessionInfo(handle.agentSessionId, {
				dir: handle.worktreePath,
			});
			if (info?.summary) {
				await this.setTitle(id, info.summary);
			}
		} catch {
			// title sync is best-effort
		}
	}
}

export const sessionManager = new SessionManager();
