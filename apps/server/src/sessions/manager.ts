import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as setTimeoutAsync } from "node:timers/promises";
import { promisify } from "node:util";
import {
	getSessionInfo,
	getSessionMessages,
	type SDKRateLimitInfo,
	type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	AgentStreamEvent,
	AgentType,
	ChangedFile,
	CommitInfo,
	Message,
	MessagePart,
	RateLimitWindow,
	RateLimitWindowKind,
	Session,
	SessionListEvent,
	SessionView,
} from "@dilna/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
	type ClaudeHandle,
	type ClaudeStartOptions,
	chatClaude,
	startClaude,
} from "../agents/claude";
import { fetchClaudeOauthUsage } from "../agents/claudeUsage";
import {
	IDLE_TIMEOUT_MS,
	STOP_TIMEOUT_MS,
	TURN_TIMEOUT_MS,
} from "../agents/types";
import { getDb } from "../db";
import {
	messages as messagesTable,
	rateLimits as rateLimitsTable,
	sessions as sessionsTable,
} from "../db/schema";
import { repoManager } from "../repos/manager";
import { computeChangedFiles } from "./diff";
import {
	freshRateLimitWindows,
	pullRateLimitsToWindows,
	type RateLimitSnapshot,
	toRateLimitWindow,
} from "./rateLimits";

const execFileAsync = promisify(execFile);

/** Floor between account-usage pulls (see `refreshRateLimits`). Matches the
 * fact that the windows move on the scale of turns, not seconds — and keeps
 * a burst of reconnecting tabs from hammering the claude.ai endpoint. */
const RATE_LIMIT_PULL_MIN_INTERVAL_MS = 60_000;

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
		usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens },
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
		usage: s.usage,
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
 * `currentTurnMessageId` merge in `agents/claude.ts`'s event normalizer).
 * Same granularity, but not the same id: with partial-message streaming the
 * live turn id is a stream event's uuid, which never appears in the
 * transcript — which is why `fetchClaudeMessagesWithRetry` gates on a raw
 * transcript uuid (`ClaudeHandle.lastAssistantTranscriptUuid`) instead.
 *
 * Tool results arrive as separate synthetic user-role transcript entries;
 * they're merged back into the owning tool_call part rather than persisted
 * as their own row. Real (non-tool-result) user entries are persisted as
 * their own text messages and also flush any in-progress assistant turn.
 *
 * Claude's transcript entries carry no timestamp, so createdAt is
 * synthesized as `now - (length - index)`: monotonically increasing within
 * the batch, ending at persist time, and never in the future. Stamping
 * *forward* from `now` (the original approach) pushed rows minutes past
 * wall clock on long transcripts, so the next turn's real-time pending-user
 * placeholder sorted *before* the previous turn's rows and the UI rendered
 * messages out of order until the next reload.
 */
export function claudeMessagesToDilna(
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
		const createdAt = baseCreatedAt - (raw.length - index);
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

/**
 * The in-flight turn's assistant message accumulated so far, mirrored
 * server-side from the same events broadcast to subscribers (same merging
 * rules as ChatShell's live state: streamed chunks join the trailing text
 * part, tool results fill their tool_call part in place). Kept in memory on
 * the ActiveAgent — never persisted; the DB stays the sole durable record
 * (ADR-0004/0014). Its purpose is the mid-turn subscribe gap: `message_start`
 * and earlier tool/token events are emitted once, so a subscriber that
 * connects mid-turn (page reload, second device) would otherwise render
 * nothing until the turn's next text token.
 */
export type LiveTurn = { messageId: string; parts: MessagePart[] };

/** Fold one broadcast event into the session's live-turn snapshot. Events
 * that don't carry message content (status, usage, diff, crash) pass the
 * snapshot through untouched. */
export function applyEventToLiveTurn(
	turn: LiveTurn | null,
	ev: AgentStreamEvent,
): LiveTurn | null {
	switch (ev.type) {
		case "message_start":
			// One assistant messageId per turn (see NormalizeState in
			// agents/claude.ts), so a start simply opens a fresh snapshot.
			return ev.role === "assistant"
				? { messageId: ev.messageId, parts: [] }
				: turn;
		case "token": {
			const t = turn ?? { messageId: ev.messageId, parts: [] };
			const last = t.parts[t.parts.length - 1];
			const parts: MessagePart[] =
				last?.type === "text"
					? [
							...t.parts.slice(0, -1),
							{ type: "text", text: last.text + ev.chunk },
						]
					: [...t.parts, { type: "text", text: ev.chunk }];
			return { messageId: t.messageId, parts };
		}
		case "tool_call_start": {
			const t = turn ?? { messageId: ev.messageId, parts: [] };
			return {
				messageId: t.messageId,
				parts: [
					...t.parts,
					{
						type: "tool_call",
						callId: ev.callId,
						tool: ev.tool,
						input: ev.input,
						// null = still running, matching the client's convention for
						// an unresolved tool call (see ChatShell's ToolCallMarker).
						output: null,
					},
				],
			};
		}
		case "tool_call_end":
			if (!turn) return turn;
			return {
				messageId: turn.messageId,
				parts: turn.parts.map((p) =>
					p.type === "tool_call" && p.callId === ev.callId
						? { ...p, output: ev.output, error: ev.error }
						: p,
				),
			};
		default:
			return turn;
	}
}

/**
 * Re-express a live-turn snapshot as the minimal event sequence a client
 * that missed the turn's start needs to catch up: one message_start, then
 * the parts in stream order (each text part as a single token chunk, each
 * tool call as start + end-if-resolved). Applying these through
 * {@link applyEventToLiveTurn} reproduces the same snapshot, so replayed and
 * live-from-the-start subscribers converge on identical state.
 */
export function liveTurnReplayEvents(turn: LiveTurn): AgentStreamEvent[] {
	const events: AgentStreamEvent[] = [
		{ type: "message_start", messageId: turn.messageId, role: "assistant" },
	];
	for (const part of turn.parts) {
		if (part.type === "text") {
			events.push({
				type: "token",
				messageId: turn.messageId,
				chunk: part.text,
			});
		} else {
			events.push({
				type: "tool_call_start",
				messageId: turn.messageId,
				callId: part.callId,
				tool: part.tool,
				input: part.input,
			});
			if (part.output !== null || part.error !== undefined) {
				events.push({
					type: "tool_call_end",
					messageId: turn.messageId,
					callId: part.callId,
					output: part.output,
					error: part.error,
				});
			}
		}
	}
	return events;
}

type Listener = (event: AgentStreamEvent) => void;

/** Thrown by the race in `runTurn` when a turn exceeds `TURN_TIMEOUT_MS`
 * with no `result`/crash from the agent backend. Distinguished from a real
 * agent error so the `catch` in `runTurn` can tell "the agent stalled"
 * apart from "the agent actually failed" and re-throw anything else as-is. */
class TurnTimeoutError extends Error {
	constructor() {
		super(`turn exceeded ${TURN_TIMEOUT_MS / 1000}s with no response`);
		this.name = "TurnTimeoutError";
	}
}

/** Thrown by `beginTurn` when the session id doesn't exist — distinguished
 * from the "already in progress" conflict so the route can map each to its
 * own HTTP status (404 vs 409) without matching on the error's message
 * string. */
export class SessionNotFoundError extends Error {
	constructor() {
		super("session not found");
		this.name = "SessionNotFoundError";
	}
}

type TurnFailedClass = Extract<
	AgentStreamEvent,
	{ type: "turn_failed" }
>["class"];

/**
 * Per-turn stop/abort state (ADR-0016 §3), claimed synchronously by
 * `beginTurn` — before `ensureStarted` even runs — so a Stop request lands
 * correctly whether the turn is still spawning (`starting`) or already
 * `working`. Kept independent of `ActiveAgent` (which doesn't exist until a
 * cold spawn finishes) in `SessionManager.turnsInProgress`, keyed by session
 * id; the single source of truth for "is a turn in flight" (`isChatInProgress`)
 * and for the 202-vs-409 accept race.
 */
type Turn = {
	abortController: AbortController;
	/** Idempotency guard: a repeated Stop call while already stopping is
	 * absorbed without restarting `escalationTimer`'s clock. */
	stopRequested: boolean;
	escalationTimer: NodeJS.Timeout | null;
	/** Set once a `turn_failed` has already routed this turn to its terminal
	 * status (stop-timeout escalation, or a crash mid-turn) — `runTurn`'s own
	 * end-of-turn status transition is then redundant and skipped, since a
	 * turn may only reach one terminal status. */
	terminalized: boolean;
};

type ActiveAgent = {
	handle: ClaudeHandle;
	idleTimer: NodeJS.Timeout | null;
	/** Snapshot of the in-flight turn's assistant message, replayed to
	 * subscribers that connect mid-turn (see {@link LiveTurn}). Null between
	 * turns — cleared after the turn's rows are persisted. */
	liveTurn: LiveTurn | null;
	/** One-shot: set by `ensureStarted` when it had to start a fresh Claude
	 * session instead of resuming (the prior one was unresumable — see
	 * `buildContextPrimer`), consumed and cleared by the next `runTurn`
	 * so the freshly-spawned agent gets dilna's own persisted history as
	 * context instead of starting completely blind. */
	contextPrimer?: string;
	/** Latest `Stop`-hook snapshot (ADR-0017): true when the SDK reports
	 * in-flight background work or a pending `ScheduleWakeup`/`CronCreate`/
	 * `/loop` registration for this session. While true, `armIdleTimer` will
	 * not arm a kill timer and `idleKill` is a no-op — the resident process
	 * must stay alive for that work to complete or the wakeup to fire. */
	hasPendingBackgroundWork: boolean;
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
	/** Last-known account-wide plan rate-limit reading per window, reported
	 * by whichever Session's agent process is currently live (see
	 * `ensureStarted`'s `onRateLimit` wiring and `sendMessage`'s post-turn
	 * pull). Account-wide, not keyed by session id — there's exactly one
	 * Anthropic account per dilna deploy. Mirrored to the `rate_limits`
	 * table on every update and hydrated from it lazily, so a page reload
	 * after a server restart shows the last reading immediately instead of
	 * waiting for the next agent turn. Staleness is computed at read time
	 * (see rateLimits.ts), not stored. */
	private rateLimits = new Map<RateLimitWindowKind, RateLimitSnapshot>();
	private rateLimitsHydrated = false;
	/** Session id -> in-flight turn's stop/abort state (ADR-0016 §2/§3). The
	 * sole source of truth for "does this session have a turn in flight" —
	 * claimed synchronously by `beginTurn`, before any spawn, so the pre-202
	 * check-and-claim can't race a second accept (see `beginTurn`'s doc
	 * comment). */
	private turnsInProgress = new Map<string, Turn>();
	/** Last `turn_failed` broadcast per session, retained until the next
	 * accepted turn (`beginTurn` clears it) so a client that subscribes after
	 * the failure — but before anything else happens — still sees why the
	 * session is `crashed`/`idle` instead of just the bare status (ADR-0016
	 * §4's snapshot rule). */
	private lastTurnFailed = new Map<string, AgentStreamEvent>();
	/** The in-flight turn's current `turn_activity`/`notice`, mirrored here so
	 * a subscriber joining mid-turn sees them too (ADR-0016 §4/§5: both are
	 * "present in the opening snapshot only mid-turn") — otherwise a
	 * reconnecting tab renders nothing until the next discrete change.
	 * Cleared at accept (`beginTurn`) and at turn end (`runTurn`), same
	 * lifetime as `ActiveAgent.liveTurn`. */
	private lastTurnActivity = new Map<string, AgentStreamEvent>();
	private lastNotice = new Map<string, AgentStreamEvent>();

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
			usage: { inputTokens: 0, outputTokens: 0 },
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

	/**
	 * The one function every status transition runs through (ADR-0016 §1): DB
	 * write → per-session broadcast → global mirror. Callers used to pair
	 * `setStatus` with their own ad-hoc `broadcast(id, {type:"session_status"...})`
	 * call, which is how the "working" transition ended up with no per-session
	 * broadcast at all (see `runTurn`'s predecessor) — subscribers only ever
	 * learned a turn had started via the replay-on-subscribe path, never live.
	 */
	private async transitionStatus(
		id: string,
		status: Session["status"],
	): Promise<void> {
		await this.setStatus(id, status);
		this.broadcast(id, { type: "session_status", status });
	}

	/**
	 * Boot-time recovery (ADR-0014). Any session still marked
	 * working/starting/stopping had a turn in flight when the previous server
	 * process died — its end-of-turn persistence never ran. The agent's own
	 * transcript is the durable record of that turn, so backfill whatever it
	 * captured into dilna's messages table, then resolve the pending-user
	 * placeholder: dropped when the transcript carried the user's message
	 * (an authoritative row now exists), promoted to a permanent row when it
	 * didn't — a restart must never delete the user's message.
	 */
	async resetAllToIdle(): Promise<void> {
		const db = getDb();
		const interrupted = ["working", "starting", "stopping"];
		const rows = db
			.select()
			.from(sessionsTable)
			.where(inArray(sessionsTable.status, interrupted))
			.all();
		for (const row of rows) {
			const session = rowToSession(row);
			let persistedUserMessage = false;
			try {
				({ persistedUserMessage } = await this.backfillFromTranscript(session));
			} catch (err) {
				console.error(
					`[sessions] boot backfill failed for ${session.id}:`,
					err,
				);
			}
			if (persistedUserMessage) {
				this.deleteMessage(session.id, this.pendingUserMessageId(session.id));
			} else {
				this.promotePendingUserMessage(session.id);
			}
		}
		db.update(sessionsTable)
			.set({ status: "idle" })
			.where(inArray(sessionsTable.status, interrupted))
			.run();
	}

	/**
	 * Recover a session's history straight from the Claude-native transcript —
	 * a JSONL file `getSessionMessages` can read with no live agent process —
	 * persisting any rows dilna doesn't already have. No-op when the session
	 * never got an agentSessionId (the turn died before the init handshake
	 * reported one): there is no transcript to read in that case.
	 */
	private async backfillFromTranscript(
		session: Session,
	): Promise<{ persistedUserMessage: boolean }> {
		if (!session.agentSessionId) return { persistedUserMessage: false };
		let raw: SessionMessage[];
		try {
			raw = await getSessionMessages(session.agentSessionId, {
				dir: session.worktreePath,
			});
		} catch (err) {
			console.error(
				`[sessions] could not read transcript ${session.agentSessionId} for ${session.id}:`,
				err,
			);
			return { persistedUserMessage: false };
		}
		return this.persistConverted(
			session.id,
			claudeMessagesToDilna(session.id, raw),
		);
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

	/**
	 * Last-known account-wide rate-limit windows, filtered for staleness at
	 * read time. Used both for the SSE snapshot-on-connect (routes/stream.ts)
	 * and is implicitly what every `rate_limits` broadcast carries.
	 */
	getRateLimits(): RateLimitWindow[] {
		this.hydrateRateLimits();
		return freshRateLimitWindows(
			this.rateLimits,
			Math.floor(Date.now() / 1000),
		);
	}

	/** Load the persisted last-known windows into memory, once. Lazy (first
	 * read or write) rather than in the constructor because the singleton is
	 * constructed at module import time, before tests get to point
	 * DILNA_DATA_DIR at their scratch directory. */
	private hydrateRateLimits(): void {
		if (this.rateLimitsHydrated) return;
		this.rateLimitsHydrated = true;
		const rows = getDb().select().from(rateLimitsTable).all();
		for (const row of rows) {
			if (row.kind !== "five_hour" && row.kind !== "seven_day") continue;
			this.rateLimits.set(row.kind, {
				utilizationPct: row.utilizationPct,
				resetsAt: row.resetsAt,
			});
		}
	}

	/**
	 * Single write path for rate-limit readings from either source (push
	 * `rate_limit_event` or post-turn pull). Rate limits are account-wide, so
	 * this updates shared state regardless of which Session reported it,
	 * mirrors each window to the `rate_limits` table (so restarts/reloads
	 * don't lose it), then re-broadcasts the full (staleness-filtered) window
	 * list on the cross-session stream — the sidebar footer's only source of
	 * truth, no dedicated poller involved.
	 */
	private applyRateLimitWindows(
		entries: { kind: RateLimitWindowKind; snapshot: RateLimitSnapshot }[],
	): void {
		if (entries.length === 0) return;
		this.hydrateRateLimits();
		const db = getDb();
		const updatedAt = Math.floor(Date.now() / 1000);
		for (const { kind, snapshot } of entries) {
			this.rateLimits.set(kind, snapshot);
			db.insert(rateLimitsTable)
				.values({
					kind,
					utilizationPct: snapshot.utilizationPct,
					resetsAt: snapshot.resetsAt,
					updatedAt,
				})
				.onConflictDoUpdate({
					target: rateLimitsTable.kind,
					set: {
						utilizationPct: snapshot.utilizationPct,
						resetsAt: snapshot.resetsAt,
						updatedAt,
					},
				})
				.run();
		}
		this.broadcastGlobal({
			type: "rate_limits",
			windows: this.getRateLimits(),
		});
	}

	/** Callback passed to `startClaude` (see `ensureStarted`). Only events
	 * that carry a real utilization number make it through
	 * `toRateLimitWindow` — the common `allowed` event omits the field and is
	 * dropped so it can't overwrite a pulled reading with a placeholder.
	 *
	 * Logged unconditionally (not just on drop): this push path still writes
	 * `utilizationPct` unconverted, on the SDK-documented assumption that
	 * `SDKRateLimitInfo.utilization` is 0-100 — the same assumption that
	 * turned out wrong for the pull endpoint's `utilization` (a 0-1 fraction,
	 * see pullRateLimitsToWindows). If this ever fires with a value that
	 * looks like a 0-1 fraction too, it's overwriting the pull's correctly
	 * scaled reading with an unconverted one, and needs the same fix. */
	private handleRateLimitEvent(info: SDKRateLimitInfo): void {
		console.error(
			`[sessions] rate_limit_event: type=${info.rateLimitType} status=${info.status} utilization=${info.utilization}`,
		);
		const parsed = toRateLimitWindow(info);
		if (!parsed) return;
		this.applyRateLimitWindows([parsed]);
	}

	/** Best-effort refresh from the claude.ai usage endpoint — the only
	 * source that reliably carries utilization for both windows (see
	 * `fetchClaudeOauthUsage`, ADR-0015). Unlike the old SDK control-request
	 * pull this needs no live agent process, so it runs both post-turn and
	 * when a cross-session stream client connects. Throttled because those
	 * triggers can cluster (several tabs reconnecting, turns finishing
	 * back-to-back) and the numbers move slowly. */
	private lastRateLimitPullMs = 0;
	private async refreshRateLimits(): Promise<void> {
		const now = Date.now();
		if (now - this.lastRateLimitPullMs < RATE_LIMIT_PULL_MIN_INTERVAL_MS) {
			return;
		}
		this.lastRateLimitPullMs = now;
		const raw = await fetchClaudeOauthUsage();
		this.applyRateLimitWindows(pullRateLimitsToWindows(raw));
	}

	/** Fire-and-forget wrapper for callers outside the turn loop
	 * (routes/stream.ts on client connect). Fresh data arrives as a
	 * `rate_limits` broadcast, not a return value. */
	pokeRateLimitRefresh(): void {
		this.refreshRateLimits().catch((err) => {
			console.error("[sessions] failed to refresh rate limits:", err);
		});
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

		// Snapshot rule (ADR-0016 §4): reproduce what a live viewer of the
		// current state would have seen. The last `turn_failed` (while still
		// current — cleared by the next accepted turn) always precedes the
		// opening status, preserving §2's "failure event precedes terminal
		// status" ordering for a subscriber who missed the original broadcast.
		const lastFailed = this.lastTurnFailed.get(id);
		if (lastFailed) listener(lastFailed);

		// Read the persisted status once (synchronously — no `await` — so this
		// stays ordered relative to any broadcast racing the same tick) and
		// share it between both branches below.
		const row = getDb()
			.select({ status: sessionsTable.status })
			.from(sessionsTable)
			.where(eq(sessionsTable.id, id))
			.get();
		const persistedStatus = row?.status as Session["status"] | undefined;

		const active = this.active.get(id);
		const inProgress = this.turnsInProgress.has(id);
		if (!active || !inProgress) {
			// No turn in flight → open with the session's real persisted status
			// (idle or crashed), not an unconditional idle — a crashed session
			// must reopen crashed, not silently reset to idle on every new
			// subscriber (ADR-0016 §1).
			listener({ type: "session_status", status: persistedStatus ?? "idle" });
		} else {
			// Joined mid-turn (page reload, another device): the in-flight
			// phase's status and the turn's message_start/tool events were
			// broadcast before this subscriber existed, so re-emit the current
			// phase and replay the turn's snapshot — without this the pane
			// stays blank until the turn's next text token, which on a
			// tool-heavy turn can be minutes away. `notice`/`turn_activity` are
			// likewise "present in the opening snapshot only mid-turn"
			// (ADR-0016 §4/§5).
			listener({
				type: "session_status",
				status: persistedStatus ?? "working",
			});
			const notice = this.lastNotice.get(id);
			if (notice) listener(notice);
			const activity = this.lastTurnActivity.get(id);
			if (activity) listener(activity);
			if (active.liveTurn) {
				for (const ev of liveTurnReplayEvents(active.liveTurn)) {
					listener(ev);
				}
			}
		}
		return () => {
			this.subscribers.get(id)?.delete(listener);
		};
	}

	/**
	 * True if the session currently has a turn in flight. Backed by
	 * `turnsInProgress`, claimed synchronously by `beginTurn` before any
	 * `await` — see that method's doc comment for why this is what makes the
	 * pre-202 409 the only duplicate-send surface (ADR-0016 §2).
	 */
	isChatInProgress(id: string): boolean {
		return this.turnsInProgress.has(id);
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
	 * Compute the Session's Worktree diff against its Repo's default-branch
	 * merge-base, including uncommitted changes (per the "Changed files"
	 * panel spec). Recomputed live from git every call — never persisted.
	 */
	async getChangedFiles(id: string): Promise<ChangedFile[]> {
		const session = await this.get(id);
		if (!session) return [];
		const repo = await repoManager.get(session.repoId);
		if (!repo) return [];
		return computeChangedFiles(session.worktreePath, repo.defaultBranch);
	}

	/**
	 * Most recent commits reachable from the Session's Worktree HEAD (its own
	 * commits first, then inherited default-branch history), for the context
	 * panel. Read live from git like getChangedFiles — never persisted.
	 * Soft-fails to [] (e.g. worktree deleted out from under the session).
	 */
	async getRecentCommits(id: string, limit = 5): Promise<CommitInfo[]> {
		const session = await this.get(id);
		if (!session) return [];
		try {
			const { stdout } = await git(
				["log", `-${limit}`, "--format=%h%x1f%s%x1f%at"],
				{ cwd: session.worktreePath },
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
	 * Claim the turn slot and persist the user's message — synchronously, with
	 * no `await` between the 409 check and the claim. This is the fix for
	 * ADR-0016 §2's post-202 duplicate-send race: the old check (in what is
	 * now `runTurn`) happened after an `await ensureStarted(...)`, so a fast
	 * second POST could pass the same check before the first request's claim
	 * ever landed, and both would get their own 202. `turnsInProgress` is
	 * claimed here instead — before `runTurn`'s spawn even starts — making the
	 * pre-202 409 the only duplicate-send surface (post-202 "already busy" is
	 * now structurally impossible).
	 *
	 * Also broadcasts `user_message` (ADR-0016 §6) so every subscriber —
	 * including the sender's own stream connection — sees the persisted row
	 * at the same time the 202 response (which echoes the same row) reaches
	 * the sender.
	 *
	 * Throws if a turn is already in progress, or the session doesn't exist —
	 * routes/sessions.ts turns the former into the 409.
	 */
	beginTurn(id: string, text: string): Message {
		if (this.turnsInProgress.has(id)) {
			throw new Error("session already has a chat in progress");
		}
		const row = getDb()
			.select({ id: sessionsTable.id })
			.from(sessionsTable)
			.where(eq(sessionsTable.id, id))
			.get();
		if (!row) throw new SessionNotFoundError();

		this.turnsInProgress.set(id, {
			abortController: new AbortController(),
			stopRequested: false,
			escalationTimer: null,
			terminalized: false,
		});
		// A `turn_failed` is only "current" until the next accepted turn
		// (ADR-0016 §4's snapshot rule); `turn_activity`/`notice` are valid
		// only inside the turn that's about to start.
		this.lastTurnFailed.delete(id);
		this.lastTurnActivity.delete(id);
		this.lastNotice.delete(id);

		const message: Message = {
			id: this.pendingUserMessageId(id),
			sessionId: id,
			role: "user",
			parts: [{ type: "text", text }],
			createdAt: Math.floor(Date.now() / 1000),
		};
		this.persistMessage(id, message);
		this.broadcast(id, { type: "user_message", message });
		return message;
	}

	/**
	 * Run a turn already claimed by `beginTurn`: spawn the agent process if
	 * it isn't running, send the message, and return once the turn reaches a
	 * terminal status. Live events are broadcast to subscribers as they
	 * arrive. The assistant's message is only persisted at turn end (fetched
	 * from the agent backend, which assigns its own id), at which point the
	 * pending-user placeholder `beginTurn` wrote is dropped or promoted (see
	 * ADR-0014).
	 *
	 * Every exit path funnels through exactly one `failTurn` call (on
	 * failure) or the normal-completion tail (on success) — never both, and
	 * never neither — so a turn always ends in exactly one terminal status,
	 * preceded by exactly one `turn_failed` on failure (ADR-0016 §2).
	 */
	async runTurn(id: string, text: string): Promise<void> {
		const turn = this.turnsInProgress.get(id);
		if (!turn) {
			console.error(
				`[sessions] runTurn invoked for ${id} with no claimed turn — dropping`,
			);
			return;
		}
		try {
			const session = await this.get(id);
			if (!session) return; // beginTurn already checked this exists

			let active: ActiveAgent;
			try {
				active = await this.ensureStarted(id, session);
			} catch (err) {
				// Nothing spawned — the placeholder can only be promoted, never
				// resolved from a transcript.
				this.promotePendingUserMessage(id);
				this.failTurn(id, turn, {
					class: "spawn_failure",
					message: `failed to start agent: ${err instanceof Error ? err.message : String(err)}`,
				});
				return;
			}

			this.clearIdleTimer(active);
			await this.transitionStatus(id, "working");

			if (turn.stopRequested) {
				// Stop landed while still spawning (cold start): per ADR-0016 §3
				// this completes the spawn but skips prompt dispatch entirely,
				// leaving the process warm rather than sending the message and
				// racing to abort it.
				await this.transitionStatus(id, "idle");
				this.armIdleTimer(id, active);
				return;
			}

			const handle = active.handle;
			const onEvent = (ev: AgentStreamEvent) => {
				// Refusal-fallback retraction (ADR-0016 §5): reset the whole
				// in-flight snapshot rather than trying to surgically evict just
				// the retracted parts (see normalizeModelRefusalFallback's doc
				// comment) — every client re-runs its on-open routine off the
				// `resync` this pairs with.
				if (ev.type === "resync") {
					active.liveTurn = null;
				} else {
					// Mirror the turn's content into the live-turn snapshot before
					// broadcasting, so a subscriber connecting between events can be
					// replayed the turn-so-far (see subscribe).
					active.liveTurn = applyEventToLiveTurn(active.liveTurn, ev);
				}
				const outgoing = this.accumulateSessionUsage(id, ev);
				if (outgoing.type === "turn_failed") {
					this.lastTurnFailed.set(id, outgoing);
				} else if (outgoing.type === "turn_activity") {
					this.lastTurnActivity.set(id, outgoing);
				} else if (outgoing.type === "notice") {
					this.lastNotice.set(id, outgoing);
				}
				this.broadcast(id, outgoing);
			};

			// One-shot: ensureStarted sets this when it had to start a fresh
			// session instead of resuming (see buildContextPrimer). Only the
			// outgoing prompt gets the recap prepended — the persisted user
			// message keeps the original text so history doesn't show it twice.
			const primer = active.contextPrimer;
			active.contextPrimer = undefined;
			const outgoingText = primer ? `${primer}\n\n${text}` : text;

			let expectedClaudeMessageId: string | undefined;
			let timedOut = false;
			let crashed = false;
			try {
				expectedClaudeMessageId = await Promise.race([
					chatClaude(handle, {
						message: outgoingText,
						onEvent,
						abortSignal: turn.abortController.signal,
					}),
					setTimeoutAsync(TURN_TIMEOUT_MS).then((): never => {
						throw new TurnTimeoutError();
					}),
				]);
			} catch (err) {
				if (err instanceof TurnTimeoutError) {
					timedOut = true;
				} else if (!handle.isAlive()) {
					// The process exited mid-turn — chatClaude's own exitListener
					// rejected with the same fact; nothing more to extract from
					// the error itself beyond "the process is gone".
					crashed = true;
				} else {
					throw err;
				}
			} finally {
				// Claude's agentSessionId is unknown until the first turn's init
				// message arrives (see claude.ts), so re-sync it post-chat.
				if (handle.agentSessionId) {
					const db = getDb();
					db.update(sessionsTable)
						.set({ agentSessionId: handle.agentSessionId })
						.where(eq(sessionsTable.id, id))
						.run();
				}

				// Persist everything we don't already have from the agent backend.
				// The placeholder is only dropped once the turn's real user row
				// landed; if the transcript never recorded the turn (crash before
				// the init handshake, transcript unreadable) it's promoted to a
				// permanent row instead — the user's message must survive every
				// failure mode (ADR-0014).
				let persistedUserMessage = false;
				try {
					({ persistedUserMessage } = await this.persistMessagesFromAgent(
						id,
						handle,
						expectedClaudeMessageId,
					));
				} catch (err) {
					console.error(
						`[sessions] failed to persist turn messages for ${id}:`,
						err,
					);
					this.failTurn(id, turn, {
						class: "persistence_failure",
						message: `failed to persist turn messages: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
				if (persistedUserMessage) {
					this.deleteMessage(id, this.pendingUserMessageId(id));
				} else {
					this.promotePendingUserMessage(id);
				}
				// The turn's rows are now in the DB (or promoted) — the in-memory
				// snapshot has served its purpose. Cleared only after persisting so
				// a subscriber connecting in between never sees neither.
				active.liveTurn = null;
				// turn_activity/notice are valid only inside a turn (ADR-0016 §5).
				this.lastTurnActivity.delete(id);
				this.lastNotice.delete(id);

				// Best-effort: if the agent auto-generated a title, sync it.
				this.maybeSyncTitle(id, handle).catch(() => {});

				if (timedOut) {
					// The process is stalled, not merely slow — route through the
					// same failure handling a real crash gets: kills the wedged
					// handle, drops it from `active` so the next send spawns fresh
					// instead of reusing (and re-hanging on) this one, and gives
					// the client an explicit, visible signal instead of leaving it
					// to infer nothing is happening.
					console.error(
						`[sessions] turn for ${id} exceeded ${TURN_TIMEOUT_MS / 1000}s with no response — treating as crashed`,
					);
					this.failTurn(id, turn, {
						class: "turn_timeout",
						message: `turn aborted after ${TURN_TIMEOUT_MS / 60000}m with no response from the agent`,
						detail: { stderrTail: handle.stderrTail.slice(-5) },
					});
				} else if (crashed) {
					this.failTurn(id, turn, {
						class: "agent_crash",
						message: "claude agent process exited",
						detail: { stderrTail: handle.stderrTail.slice(-5) },
					});
				} else if (!turn.terminalized) {
					// Normal end of turn — and not already routed to a terminal
					// status by a racing stop-timeout escalation (see
					// requestStop/escalateStopTimeout) or a persistence failure
					// just above.
					//
					// Best-effort: pull fresh account rate limits now that the
					// turn consumed quota. fetchClaudeOauthUsage already logs its
					// own soft-failures; this catch only guards unexpected errors
					// from parsing/persisting the result (applyRateLimitWindows),
					// so a bad response can't take down the turn.
					this.refreshRateLimits().catch((err) => {
						console.error(
							`[sessions] failed to apply refreshed rate limits for ${id}:`,
							err,
						);
					});

					// Recompute the "Changed files" panel's diff now that the
					// turn's worktree edits (committed or not) have settled.
					try {
						const files = await this.getChangedFiles(id);
						this.broadcast(id, { type: "changed_files", files });
					} catch (err) {
						console.error(
							`[sessions] failed to compute changed files for ${id}:`,
							err,
						);
					}

					await this.transitionStatus(id, "idle");
					this.armIdleTimer(id, active);
				}
			}
		} finally {
			if (turn.escalationTimer) clearTimeout(turn.escalationTimer);
			this.turnsInProgress.delete(id);
		}
	}

	/**
	 * Broadcast the turn's one `turn_failed` event and route to its mapped
	 * terminal status (ADR-0016 §2's class→terminal table:
	 * `spawn_failure`/`agent_crash`/`turn_timeout` → `crashed`;
	 * `turn_error`/`persistence_failure` → `idle`). Idempotent per turn — a
	 * turn may reach exactly one terminal status, so a second call (e.g. the
	 * stop-timeout escalation racing a genuine crash) is a no-op.
	 */
	private failTurn(
		id: string,
		turn: Turn,
		failure: {
			class: TurnFailedClass;
			message: string;
			detail?: { exitCode?: number; stderrTail?: string[] };
		},
	): void {
		if (turn.terminalized) return;
		turn.terminalized = true;

		const ev: AgentStreamEvent = { type: "turn_failed", ...failure };
		this.lastTurnFailed.set(id, ev);
		this.broadcast(id, ev);

		const crashy =
			failure.class === "spawn_failure" ||
			failure.class === "agent_crash" ||
			failure.class === "turn_timeout";
		if (crashy) {
			this.markCrashed(id);
		} else {
			void this.transitionStatus(id, "idle");
			const active = this.active.get(id);
			if (active) this.armIdleTimer(id, active);
		}
	}

	/**
	 * Stop the in-flight turn, if any (ADR-0016 §3). Aborts via the SDK's
	 * `interrupt()` (wired through `chatClaude`'s `abortSignal`) rather than
	 * killing the process — the process stays warm and the session lands
	 * `idle`, a clean ending with no `turn_failed`. No-op success when there
	 * is no turn in progress, and idempotent while stopping is already under
	 * way (a repeat call does not restart the escalation clock). Bounded by
	 * `STOP_TIMEOUT_MS`: if the turn hasn't reached a terminal status by
	 * then, `escalateStopTimeout` hard-kills the process instead.
	 */
	async requestStop(id: string): Promise<void> {
		const turn = this.turnsInProgress.get(id);
		if (!turn) return;
		if (turn.stopRequested) return;
		turn.stopRequested = true;
		await this.transitionStatus(id, "stopping");
		turn.abortController.abort();
		turn.escalationTimer = setTimeout(
			() => this.escalateStopTimeout(id),
			STOP_TIMEOUT_MS,
		);
	}

	/**
	 * `requestStop`'s escalation: `interrupt()` didn't bring the turn to a
	 * terminal status within `STOP_TIMEOUT_MS`, so the process is wedged, not
	 * just slow to acknowledge. Hard-kills it via the same `turn_failed`
	 * path a real crash gets (`markCrashed`, inside `failTurn`) — no new
	 * failure class. `failTurn`'s `terminalized` guard makes this safe to
	 * race against `runTurn`'s own completion (whichever gets there first
	 * wins; the other call is a no-op).
	 */
	private escalateStopTimeout(id: string): void {
		const turn = this.turnsInProgress.get(id);
		if (!turn || turn.terminalized) return;
		console.error(
			`[sessions] stop for ${id} did not complete within ${STOP_TIMEOUT_MS / 1000}s — killing the process`,
		);
		this.failTurn(id, turn, {
			class: "turn_timeout",
			message: `stop did not complete within ${STOP_TIMEOUT_MS / 1000}s with no response from the agent`,
		});
	}

	/**
	 * Fold a turn-end `usage_update` into the session's lifetime token totals.
	 *
	 * Despite the SDK docs describing result usage as cumulative "for the
	 * session", in dilna's streaming-input mode it is per-turn — verified
	 * empirically with two turns in one process (3319 then 2 input tokens,
	 * not a running sum), and it also resets on every process respawn. So
	 * the turn's value is simply added to the `sessions` row, and the
	 * outgoing event's `cumulative` is rewritten to the persisted lifetime
	 * total — the badge's live snap-to number is then the same one
	 * `GET /api/sessions/:id` serves after a reload. Non-turn-end events
	 * pass through untouched.
	 */
	private accumulateSessionUsage(
		sessionId: string,
		ev: AgentStreamEvent,
	): AgentStreamEvent {
		if (ev.type !== "usage_update" || !ev.cumulative) return ev;

		const db = getDb();
		db.update(sessionsTable)
			.set({
				inputTokens: sql`${sessionsTable.inputTokens} + ${ev.cumulative.inputTokens}`,
				outputTokens: sql`${sessionsTable.outputTokens} + ${ev.cumulative.outputTokens}`,
			})
			.where(eq(sessionsTable.id, sessionId))
			.run();
		const row = db
			.select({
				inputTokens: sessionsTable.inputTokens,
				outputTokens: sessionsTable.outputTokens,
			})
			.from(sessionsTable)
			.where(eq(sessionsTable.id, sessionId))
			.get();
		if (!row) return ev;
		return {
			...ev,
			cumulative: {
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
			},
		};
	}

	/**
	 * Fetch the current message list from the agent backend and persist any
	 * messages dilna doesn't already have. Maps each backend's native
	 * transcript shape into dilna's normalized MessagePart shape. Returns
	 * whether a user-role row was among the freshly persisted ones — the
	 * caller uses that to decide the pending-user placeholder's fate (drop vs
	 * promote, see sendMessage).
	 */
	private async persistMessagesFromAgent(
		sessionId: string,
		handle: ClaudeHandle,
		expectedClaudeMessageId?: string,
	): Promise<{ persistedUserMessage: boolean }> {
		if (!handle.agentSessionId) return { persistedUserMessage: false };
		const converted = await this.fetchClaudeMessagesWithRetry(
			sessionId,
			handle,
			expectedClaudeMessageId,
		);
		return this.persistConverted(sessionId, converted);
	}

	/**
	 * Persist every converted transcript row dilna doesn't already have.
	 * Shared tail of the two recovery-aware persistence paths (end-of-turn
	 * via persistMessagesFromAgent, boot backfill via backfillFromTranscript).
	 */
	private async persistConverted(
		sessionId: string,
		converted: Message[],
	): Promise<{ persistedUserMessage: boolean }> {
		const persisted = await this.getMessages(sessionId);
		const existing = new Set(persisted.map((m) => m.id));
		const fresh = converted.filter((msg) => !existing.has(msg.id));
		if (fresh.length === 0) return { persistedUserMessage: false };

		// Rows persisted before the past-stamping fix can carry timestamps
		// minutes in the future; shift this batch above them so createdAt
		// ordering stays monotonic for legacy sessions (drift then shrinks to
		// nothing as wall clock catches up).
		const pendingId = this.pendingUserMessageId(sessionId);
		const maxExisting = Math.max(
			0,
			...persisted.filter((m) => m.id !== pendingId).map((m) => m.createdAt),
		);
		const minFresh = Math.min(...fresh.map((m) => m.createdAt));
		if (minFresh <= maxExisting) {
			const shift = maxExisting + 1 - minFresh;
			for (const msg of fresh) msg.createdAt += shift;
		}

		// The transcript carries no timestamps (see claudeMessagesToDilna), but
		// this turn's user message has a real one: the pending placeholder row
		// written at send time. Hand it to the batch's last user row (the one
		// the placeholder stands in for) so history shows when the user actually
		// sent it, not when the turn ended. Skipped when it would break
		// monotonic ordering (e.g. a recovery batch spanning several turns, or
		// legacy future-stamped rows above).
		const pending = persisted.find((m) => m.id === pendingId);
		const turnUserRow = fresh.filter((m) => m.role === "user").at(-1);
		if (pending && turnUserRow) {
			const idx = fresh.indexOf(turnUserRow);
			const prevStamp =
				idx > 0 ? (fresh[idx - 1]?.createdAt ?? 0) : maxExisting;
			if (pending.createdAt >= prevStamp) {
				turnUserRow.createdAt = pending.createdAt;
			}
		}

		for (const msg of fresh) {
			this.persistMessage(sessionId, msg);
		}
		return { persistedUserMessage: fresh.some((m) => m.role === "user") };
	}

	/**
	 * `getSessionMessages` reads Claude's own JSONL transcript file, which
	 * can lag behind the live event stream: the `result` event that resolves
	 * {@link chatClaude} doesn't guarantee the transcript write for that same
	 * turn has landed on disk yet.
	 *
	 * `expectedMessageId` is the transcript uuid of the turn's *last*
	 * complete assistant message (see chatClaude's return value) — its
	 * presence means the final round has been flushed. On top of that this
	 * requires the *raw* transcript to be stable (same length and same last
	 * entry) across two consecutive polls before accepting it, so trailing
	 * writes (the final round's tool results, the result entry) have settled
	 * too.
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
		await this.transitionStatus(id, "idle");
	}

	private async ensureStarted(
		id: string,
		session: Session,
	): Promise<ActiveAgent> {
		const existing = this.active.get(id);
		if (existing?.handle.isAlive()) return existing;
		if (existing) this.active.delete(id);

		await this.transitionStatus(id, "starting");

		if (session.agentType === "openai") {
			throw new Error("openai agent backend is not implemented yet");
		}

		// dilna's own history can outlive the Claude-native session it came
		// from (e.g. CLAUDE_CONFIG_DIR wasn't on a persistent volume before —
		// see db/index.ts — so a pod restart wiped the local transcript while
		// this row's agentSessionId survived in dilna's own DB). Resuming a
		// session whose transcript is gone fails mid-turn with "No
		// conversation found with session ID: ..." and, worse, the process
		// stays wedged on that same dead id for every subsequent send. Check
		// upfront instead of discovering it that way: if the target isn't
		// resumable, start fresh and prime it with dilna's own persisted
		// history so the agent isn't starting completely blind.
		let resumeId = session.agentSessionId ?? undefined;
		let contextPrimer: string | undefined;
		if (resumeId) {
			const resumable = await this.isSessionResumable(
				resumeId,
				session.worktreePath,
			);
			if (!resumable) {
				console.error(
					`[sessions] claude session ${resumeId} for ${id} is no longer resumable — starting a fresh session primed with dilna's own history`,
				);
				resumeId = undefined;
				contextPrimer = await this.buildContextPrimer(id);
				// Degraded success, not failure (ADR-0016 §2): the agent's own
				// memory of the conversation is gone, but dilna's history and the
				// worktree's files are unaffected — a transient inline notice,
				// not a turn_failed. Retained for the mid-turn subscribe snapshot
				// (ADR-0016 §4/§5) same as the aggregate below.
				const noticeEvent: AgentStreamEvent = {
					type: "notice",
					message:
						"Couldn't resume the previous agent session — started a fresh one primed with this session's history.",
				};
				this.lastNotice.set(id, noticeEvent);
				this.broadcast(id, noticeEvent);
			}
		}

		const startOpts: ClaudeStartOptions = {
			worktreePath: session.worktreePath,
			existingAgentSessionId: resumeId,
			onRateLimit: (info) => this.handleRateLimitEvent(info),
			// Persist the Claude-side session id the moment the init handshake
			// reports it (ADR-0014). It used to be persisted only at turn end,
			// so a session whose *first* turn was interrupted kept a null
			// agentSessionId forever — its transcript (and all the agent's
			// work) was permanently orphaned even though the file survived.
			onInit: (agentSessionId) => {
				getDb()
					.update(sessionsTable)
					.set({ agentSessionId })
					.where(eq(sessionsTable.id, id))
					.run();
			},
			onPendingWorkChanged: (hasPendingWork) =>
				this.handlePendingWorkChanged(id, hasPendingWork),
		};
		const handle: ClaudeHandle = await startClaude(startOpts);

		// Cold-resume path (ADR-0003): re-persist the resumed id right away.
		// A fresh session has no id yet at this point (the getter is empty
		// until init) — writing that would clobber nothing, but skip it so
		// the row never holds an empty string; onInit above fills it in.
		if (handle.agentSessionId) {
			const db = getDb();
			db.update(sessionsTable)
				.set({ agentSessionId: handle.agentSessionId })
				.where(eq(sessionsTable.id, id))
				.run();
		}

		const active: ActiveAgent = {
			handle,
			idleTimer: null,
			liveTurn: null,
			contextPrimer,
			hasPendingBackgroundWork: false,
		};
		this.active.set(id, active);
		// Deliberately no status transition here: per ADR-0016 §1 a cold send's
		// sequence is starting → working → terminal, with no idle in between —
		// the caller (runTurn) transitions straight to "working" next. This path
		// only runs on an actual spawn (the isAlive check above short-circuits a
		// warm send before ever reaching "starting"), so there is no other
		// caller relying on an idle status landing here.
		return active;
	}

	/**
	 * Whether `agentSessionId`'s local transcript still exists. Inconclusive
	 * lookup failures (permission errors, transient IO) resolve `true` —
	 * this gate exists to skip a resume that's *guaranteed* to fail, not to
	 * second-guess one that might still succeed.
	 */
	private async isSessionResumable(
		agentSessionId: string,
		worktreePath: string,
	): Promise<boolean> {
		try {
			const info = await getSessionInfo(agentSessionId, { dir: worktreePath });
			return info !== undefined;
		} catch {
			return true;
		}
	}

	/**
	 * Recap dilna's own persisted history as a single priming message for a
	 * freshly-started (non-resumed) Claude session — see `ensureStarted`.
	 * Capped so a long-lived session's full history can't blow the new
	 * turn's context budget; older messages are dropped from the front
	 * rather than truncated mid-message.
	 */
	private async buildContextPrimer(id: string): Promise<string | undefined> {
		const MAX_CHARS = 20_000;
		const history = await this.getMessages(id);
		const lines = history
			.map((m) => {
				const text = m.parts
					.map((p) => (p.type === "text" ? p.text : `[used tool: ${p.tool}]`))
					.join("\n")
					.trim();
				return text ? `${m.role}: ${text}` : null;
			})
			.filter((l): l is string => l !== null);
		if (lines.length === 0) return undefined;

		let recap = lines.join("\n\n");
		let truncated = false;
		while (recap.length > MAX_CHARS && lines.length > 1) {
			lines.shift();
			recap = lines.join("\n\n");
			truncated = true;
		}

		return [
			"[dilna: this worktree has prior conversation history, but the agent",
			"session that produced it was lost and could not be resumed — only the",
			"agent's own memory of the conversation is gone, the worktree's files",
			"are unaffected. Recovered from dilna's own history for context",
			truncated
				? "(earlier messages omitted for length):"
				: "before continuing:",
			"",
			recap,
			"",
			"[end of recovered history — the message below continues this",
			"conversation]",
		].join("\n");
	}

	/** No-op while `hasPendingBackgroundWork` is set (ADR-0017) — a scheduled
	 * wakeup or a still-running background task needs the resident process
	 * alive to fire/finish, and dilna's own turn tracking has no visibility
	 * into either, so it must defer to the SDK's own Stop-hook signal instead
	 * of blindly starting the countdown. `handlePendingWorkChanged` is
	 * responsible for arming the timer once that signal clears. */
	private armIdleTimer(id: string, active: ActiveAgent) {
		this.clearIdleTimer(active);
		if (active.hasPendingBackgroundWork) return;
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
		if (!active || this.turnsInProgress.has(id)) return;
		// Defensive re-check (ADR-0017): the timer that led here could have
		// been armed just before a Stop-hook callback set this, since the
		// hook and the turn-end path that calls armIdleTimer race each other.
		if (active.hasPendingBackgroundWork) return;
		await this.stopSession(id);
	}

	/**
	 * ADR-0017: consumes the Claude Agent SDK's `Stop`-hook snapshot of
	 * in-flight background work / pending cron-style wakeups
	 * (`ClaudeStartOptions.onPendingWorkChanged`), which fires once per
	 * response — including responses the CLI generates on its own when a
	 * `ScheduleWakeup`/`CronCreate`/`/loop` registration fires, something
	 * `SessionManager` has no other visibility into since those never go
	 * through `chatClaude`. Turning pending work off is the only path that
	 * re-arms the idle timer for such an autonomous response, since nothing
	 * else in `SessionManager` knows one happened.
	 */
	private handlePendingWorkChanged(id: string, hasPendingWork: boolean) {
		const active = this.active.get(id);
		if (!active) return;
		active.hasPendingBackgroundWork = hasPendingWork;
		if (hasPendingWork) {
			this.clearIdleTimer(active);
			return;
		}
		// Only (re-)arm here when the session is actually idle and untracked —
		// a turn dilna itself is driving will arm the timer through the normal
		// turn-end path once it finishes, and arming early here would race it.
		if (!active.idleTimer && !this.turnsInProgress.has(id)) {
			this.armIdleTimer(id, active);
		}
	}

	private markCrashed(id: string) {
		const active = this.active.get(id);
		if (active) {
			this.clearIdleTimer(active);
			this.active.delete(id);
			void active.handle.stop().catch(() => {});
		}
		void this.transitionStatus(id, "crashed");
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

	/**
	 * Rename the pending-user placeholder into a permanent row (fresh unique
	 * id, content and timestamp untouched) instead of deleting it. Used when
	 * a turn ended without the transcript recording the user's message —
	 * crash before the init handshake, interrupted first turn, unreadable
	 * transcript — so the message is never lost, and the stable per-session
	 * placeholder id is freed for the next turn. No-op when no placeholder
	 * row exists.
	 */
	private promotePendingUserMessage(sessionId: string): void {
		const db = getDb();
		db.update(messagesTable)
			.set({ id: nanoid() })
			.where(
				and(
					eq(messagesTable.sessionId, sessionId),
					eq(messagesTable.id, this.pendingUserMessageId(sessionId)),
				),
			)
			.run();
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
