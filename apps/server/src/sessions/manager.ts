import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
	AgentStreamEvent,
	AgentType,
	ChangedFile,
	CommitInfo,
	ContextUsageEstimate,
	Message,
	MessagePart,
	RateLimitWindow,
	RateLimitWindowKind,
	Session,
	SessionKind,
	SessionListEvent,
	SessionView,
} from "@dilna/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
	buildInitialMessages,
	chatPi,
	checkSessionContext,
	estimateSessionContext,
	generateSessionTitle,
	type OrchestratorDeps,
	type PiHandle,
	type PiStartOptions,
	piMessagesToDilna,
	type SessionCompaction,
	startOrchestrator,
	startPi,
	summarizeSessionForArchive,
} from "../agents/pi";
import {
	effectiveModel,
	effectiveProvider,
} from "../agents/providerConfigStore";
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
	usageEvents as usageEventsTable,
} from "../db/schema";
import { repoManager } from "../repos/manager";
import {
	archiveSession as archiveSessionRow,
	getArchivedSession,
	listArchivedSessions,
} from "./archive";
import { computeChangedFiles } from "./diff";
import { freshRateLimitWindows, type RateLimitSnapshot } from "./rateLimits";

const execFileAsync = promisify(execFile);

async function git(args: string[], opts: { cwd?: string } = {}) {
	return execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });
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
async function initCodegraph(worktreePath: string): Promise<void> {
	try {
		await execFileAsync("codegraph", ["init", "--yes"], {
			cwd: worktreePath,
			maxBuffer: 50 * 1024 * 1024,
		});
	} catch (err) {
		console.error(
			`[sessions] codegraph init failed for ${worktreePath} (continuing without it):`,
			err,
		);
	}
}

function rowToSession(row: typeof sessionsTable.$inferSelect): Session {
	return {
		id: row.id,
		repoId: row.repoId,
		worktreePath: row.worktreePath,
		worktreeDirName: row.worktreeDirName,
		branchName: row.branchName,
		agentType: row.agentType as AgentType,
		kind: row.kind as SessionKind,
		title: row.title,
		status: row.status as Session["status"],
		usage: { inputTokens: row.inputTokens, outputTokens: row.outputTokens },
		compactedSummary: row.compactedSummary,
		compactedThroughMessageId: row.compactedThroughMessageId,
		spawnedBy: row.spawnedBy,
		provider: row.provider,
		model: row.model,
		createdAt: row.createdAt,
		lastActiveAt: row.lastActiveAt,
	};
}

/**
 * The framework-generated placeholder every ordinary (non-orchestrator)
 * Session is created with, before its first turn's title derivation runs
 * (see {@link SessionManager.maybeDeriveTitle}). `create()` and the
 * first-turn guard share this so they can stay in lockstep about what
 * "still needs a derived title" means.
 */
function defaultSessionTitle(id: string): string {
	return `Session ${id.slice(0, 4)}`;
}

/** `Session`'s two compaction columns (ADR-0023), reshaped into pi.ts's
 * `SessionCompaction` — the one place that pairing happens, so every caller
 * (the turn-end check, the idle-session REST estimate) treats "only one of
 * the two columns is set" the same way (falls back to `null`, i.e. no
 * compaction — shouldn't happen since both are always written together, but
 * there's no DB constraint enforcing that). */
function sessionCompactionOf(session: Session): SessionCompaction {
	return session.compactedSummary && session.compactedThroughMessageId
		? {
				summary: session.compactedSummary,
				throughMessageId: session.compactedThroughMessageId,
			}
		: null;
}

function toView(s: Session): SessionView {
	return {
		id: s.id,
		repoId: s.repoId,
		title: s.title,
		agentType: s.agentType,
		kind: s.kind,
		provider: s.provider,
		model: s.model,
		status: s.status,
		usage: s.usage,
		createdAt: s.createdAt,
		lastActiveAt: s.lastActiveAt,
	};
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

/** Thrown by the race in `runTurn` when `TURN_TIMEOUT_MS` passes with no
 * event of any kind from the agent backend — an inactivity gap, not a cap
 * on the turn's total length; `runTurn`'s `onEvent` bumps the watchdog on
 * every event, so a turn that's still actively streaming or running tools
 * survives past the threshold as long as something keeps arriving.
 * Distinguished from a real agent error so the `catch` in `runTurn` can tell
 * "the agent stalled" apart from "the agent actually failed" and re-throw
 * anything else as-is. */
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
	handle: PiHandle;
	idleTimer: NodeJS.Timeout | null;
	/** Snapshot of the in-flight turn's assistant message, replayed to
	 * subscribers that connect mid-turn (see {@link LiveTurn}). Null between
	 * turns — cleared after the turn's rows are persisted. */
	liveTurn: LiveTurn | null;
	/**
	 * How many of `handle.agent.state.messages` are already durably
	 * persisted to dilna's DB — the slice boundary `runTurn` reads a turn's
	 * new entries from (see `persistMessagesFromAgent`). Only advanced after
	 * a successful persist, never reset to the raw pre-turn message count:
	 * if persistence fails for turn N (a transient DB error), this stays put
	 * so turn N's entries are retried as part of turn N+1's slice instead of
	 * being silently skipped forever once `state.messages` has moved past
	 * them. `persistConverted`'s existing id-based dedup makes a wider,
	 * partially-overlapping retry slice safe. Initialized in `startAgent` to
	 * the length of the seeded `initialMessages` (dilna's own persisted
	 * history) — everything at or before that point is already in the DB by
	 * construction. */
	persistedCount: number;
};

class SessionManager {
	/** Map of active dilna session id -> running agent process. */
	private active = new Map<string, ActiveAgent>();
	/** Map of dilna session id -> in-flight `ensureStarted` promise. Without
	 * this, two `sendMessage` calls that both arrive while `active` has no
	 * (alive) entry — e.g. two rapid sends right after a server restart —
	 * would each race through `ensureStarted`'s several `await`s, spawn their
	 * own agent process, and overwrite each other in `active`. Both would
	 * then see `chatInProgress: false` on their own distinct `ActiveAgent`
	 * and proceed to insert the same `pending-user-<id>` placeholder row,
	 * violating the messages primary key. Singleflighting the start makes
	 * the second caller await and reuse the first caller's in-progress
	 * start instead of racing it. */
	private starting = new Map<string, Promise<ActiveAgent>>();
	/** Map of dilna session id -> SSE subscribers (browser tabs etc). Kept
	 * independent of the agent lifecycle so a UI tab can subscribe before
	 * any agent is running and still receive events once it starts. */
	private subscribers = new Map<string, Set<Listener>>();
	/** Cross-session status subscribers (per ADR-0008): one subscription per
	 * app load, notified on every status change of every session. */
	private globalSubscribers = new Set<(event: SessionListEvent) => void>();
	/** Last-known account-wide plan rate-limit reading per window. Nothing
	 * currently writes new readings here — that mechanism was claude.ai-
	 * OAuth-specific (a push `rate_limit_event` plus a post-turn usage pull,
	 * both dropped alongside `claude.ts`/`claudeUsage.ts`; OAuth is gone
	 * entirely under the pi-stack migration) — so this only ever serves
	 * whatever was persisted before that migration, hydrated lazily from the
	 * `rate_limits` table so a page reload shows it without waiting on
	 * anything. Staleness is computed at read time (see rateLimits.ts), not
	 * stored. */
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

	/** Token usage grouped by repo, across ordinary (non-orchestrator)
	 * Sessions — backs the orchestrator's `dilna_usage_totals` tool. */
	async usageTotalsByRepo(): Promise<
		{ repoId: string; inputTokens: number; outputTokens: number }[]
	> {
		const db = getDb();
		const rows = db
			.select({
				repoId: sessionsTable.repoId,
				inputTokens: sql<number>`sum(${sessionsTable.inputTokens})`,
				outputTokens: sql<number>`sum(${sessionsTable.outputTokens})`,
			})
			.from(sessionsTable)
			.where(eq(sessionsTable.kind, "session"))
			.groupBy(sessionsTable.repoId)
			.all();
		return rows.map((r) => ({
			repoId: r.repoId,
			inputTokens: Number(r.inputTokens) || 0,
			outputTokens: Number(r.outputTokens) || 0,
		}));
	}

	/**
	 * The narrow dependency surface an orchestrator Agent's tools call back
	 * into — passed down through `startOrchestrator` rather than
	 * `agents/pi.ts` importing `sessionManager` directly, which would cycle
	 * (this file already imports from `agents/pi.ts`). Every orchestrator
	 * tool result excludes other orchestrator Sessions — they're not children,
	 * and aren't what "ask about usage/sessions" means here.
	 *
	 * `orchestratorSessionId` (ADR-0025) is this specific orchestrator
	 * Session's own id — closed over here, never accepted as a tool
	 * parameter from the model, so `spawnedByMe` can't be spoofed to see
	 * another orchestrator's lineage.
	 */
	private buildOrchestratorDeps(
		orchestratorSessionId: string,
	): OrchestratorDeps {
		return {
			listSessions: async (repoId, spawnedByMe) => {
				const db = getDb();
				const conditions = [eq(sessionsTable.kind, "session")];
				if (repoId) conditions.push(eq(sessionsTable.repoId, repoId));
				if (spawnedByMe) {
					conditions.push(eq(sessionsTable.spawnedBy, orchestratorSessionId));
				}
				const rows = db
					.select()
					.from(sessionsTable)
					.where(and(...conditions))
					.orderBy(asc(sessionsTable.lastActiveAt))
					.all();
				return rows.map(rowToSession).map(toView);
			},
			getSession: async (id) => {
				const view = await this.getView(id);
				if (!view || view.kind === "orchestrator") return null;
				const messages = await this.getMessages(id);
				const last = messages.at(-1);
				const lastMessagePreview = last
					? last.parts
							.filter(
								(p): p is Extract<MessagePart, { type: "text" }> =>
									p.type === "text",
							)
							.map((p) => p.text)
							.join(" ")
							.trim()
							.slice(0, 240) || null
					: null;
				return { ...view, lastMessagePreview };
			},
			createChildSession: async (repoId, prompt) => {
				const view = await this.create(
					repoId,
					"pi",
					"session",
					orchestratorSessionId,
				);
				this.beginTurn(view.id, prompt);
				this.runTurn(view.id, prompt).catch((err) => {
					console.error(
						`[sessions] orchestrator-spawned runTurn failed for ${view.id}:`,
						err,
					);
				});
				return view;
			},
			usageTotalsByRepo: () => this.usageTotalsByRepo(),
			listArchivedSessions: (repoId) =>
				Promise.resolve(listArchivedSessions(repoId)),
			getArchivedSession: (sessionId) =>
				Promise.resolve(getArchivedSession(sessionId)),
		};
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

	/**
	 * `GET /api/sessions/:id`'s `contextUsage` field (ADR-0023's addendum) —
	 * lets a page load/session switch show a Session's context occupancy
	 * immediately, rather than the sidebar meter staying blank until the next
	 * `context_usage` broadcast (which only fires at an in-progress turn's
	 * end). `null` for an orchestrator Session (no compaction, no model
	 * concept meaningful to report) or one whose provider/model has since
	 * fallen out of dilna's catalog.
	 *
	 * A live Session's already-running `Agent` captured its provider/model at
	 * construction (`PiHandle.provider`/`.model`); an idle one has none, so
	 * this falls back to whatever's currently configured — the same
	 * resolution `startAgent` would use if the Session resumed right now (see
	 * `PiHandle`'s doc comment on why a long-lived live Session can drift
	 * from that).
	 */
	async getContextUsageEstimate(
		id: string,
	): Promise<ContextUsageEstimate | null> {
		const session = await this.get(id);
		if (session?.kind !== "session") return null;

		const active = this.active.get(id);
		const provider = active
			? active.handle.provider
			: (session.provider ?? effectiveProvider());
		const model = active
			? active.handle.model
			: (session.model ?? effectiveModel());

		const pendingId = this.pendingUserMessageId(id);
		const history = (await this.getMessages(id)).filter(
			(m) => m.id !== pendingId,
		);
		return estimateSessionContext(
			provider,
			model,
			history,
			sessionCompactionOf(session),
		);
	}

	async create(
		repoId: string,
		agentType: AgentType = "pi",
		kind: SessionKind = "session",
		/** ADR-0025: the orchestrator Session's own id, when this call came
		 * from `dilna_create_session` — omitted (null) for every other
		 * caller. */
		spawnedBy: string | null = null,
	): Promise<SessionView> {
		// Anything other than "pi" is rejected outright — including a legacy
		// "claude" value on a pre-migration row passed in by a caller that
		// hasn't been updated, not just the reserved "openai" placeholder.
		// There is no migration path for old rows (per the wayfinder map's
		// "claude never existed" framing): a value this dispatch rejects is
		// permanently inert, not silently reinterpreted as "pi".
		if (agentType !== "pi") {
			throw new Error(`${agentType} agent backend is not implemented`);
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

		await initCodegraph(worktreePath);

		const now = Math.floor(Date.now() / 1000);
		const session: Session = {
			id,
			repoId: repo.id,
			worktreePath,
			worktreeDirName,
			branchName,
			agentType,
			kind,
			// Framework-generated placeholder (orchestrator Sessions keep their
			// fixed "Orchestrator" title forever). For ordinary pi Sessions this is
			// temporary: it's replaced on the Session's first turn by
			// maybeDeriveTitle, which asks the pi agent itself for a short title
			// from the user's first prompt (pi has no auto-derived-title
			// equivalent, unlike the retired Claude backend — see ADR-0020).
			title: kind === "orchestrator" ? "Orchestrator" : defaultSessionTitle(id),
			status: "idle",
			usage: { inputTokens: 0, outputTokens: 0 },
			compactedSummary: null,
			compactedThroughMessageId: null,
			spawnedBy,
			// Settings snapshot of the model this Session was created to run on
			// (multi-provider support): resolve the effective override/env config
			// now, at create time, so this Session is pinned to *that* model rather
			// than whatever the instance default becomes later. A gap in coverage
			// (override not yet resolvable because env/keys aren't set) stores
			// null and lets startAgent lazily resolve when it first runs instead.
			provider: effectiveProvider() || null,
			model: effectiveModel() || null,
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
				kind: session.kind,
				title: session.title,
				status: session.status,
				spawnedBy: session.spawnedBy,
				provider: session.provider,
				model: session.model,
				createdAt: session.createdAt,
				lastActiveAt: session.lastActiveAt,
			})
			.run();

		const view = toView(session);
		this.broadcastGlobal({ type: "session_status", session: view });
		return view;
	}

	/**
	 * The only way an orchestrator Session ever gets created — `repoId` is
	 * always the meta-repo, never a caller-supplied value (see ADR-0021's
	 * "why not nullable repoId" and routes/sessions.ts's dedicated
	 * `POST /orchestrator`, which is what makes this the only entry point).
	 */
	async createOrchestrator(): Promise<SessionView> {
		const metaRepo = await repoManager.ensureOrchestratorRepo();
		return this.create(metaRepo.id, "pi", "orchestrator");
	}

	async delete(id: string): Promise<void> {
		const session = await this.get(id);
		if (!session) return;

		// Captured before `stopSession` below, which removes this Session's
		// `ActiveAgent` entry (and with it, its live `PiHandle.provider`/
		// `.model`) — an idle Session falls back to its own snapshot (taken at
		// create; then the currently-effective config for pre-migration rows),
		// same resolution `getContextUsageEstimate` uses.
		const active = this.active.get(id);
		const provider = active
			? active.handle.provider
			: (session.provider ?? effectiveProvider());
		const model = active
			? active.handle.model
			: (session.model ?? effectiveModel());

		// Kill any running agent first.
		await this.stopSession(id);

		// Archive before destroying (ADR-0024) — ordinary Sessions only;
		// orchestrator ones have no coding content worth referencing later,
		// same exclusion as ADR-0023's compaction.
		if (session.kind === "session") {
			await this.archiveBeforeDelete(session, provider, model);
		}

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

	/**
	 * Best-effort (ADR-0024): a resolution or summarization failure is logged
	 * and swallowed, not thrown — `delete` proceeds either way. A Session
	 * delete failing outright because an LLM call failed would be worse than
	 * an occasional un-archived Session. A Session with no messages (deleted
	 * before its first turn) archives nothing, same as
	 * `summarizeSessionForArchive`'s own empty-history guard.
	 */
	private async archiveBeforeDelete(
		session: Session,
		provider: string,
		model: string,
	): Promise<void> {
		try {
			const history = await this.getMessages(session.id);
			const summary = await summarizeSessionForArchive(
				provider,
				model,
				history,
				sessionCompactionOf(session),
			);
			if (!summary) return;
			archiveSessionRow({
				sessionId: session.id,
				repoId: session.repoId,
				title: session.title,
				summary,
				createdAt: session.createdAt,
			});
		} catch (err) {
			console.error(
				`[sessions] archival failed for ${session.id}, deleting without an archive: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
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

	/**
	 * Replace a Session's generic placeholder title with a short, meaningful one
	 * derived from its very first prompt — best-effort, and only for the first
	 * turn of an ordinary (non-orchestrator) pi Session.
	 *
	 * This closes the title gap left when the retired Claude backend (which
	 * auto-derived a title from its transcript summary) was replaced with the
	 * pi stack (no CLI, no transcript summary — see ADR-0020): the framework
	 * still only ever writes the generic placeholder at creation time, so
	 * without this the title would stay generic forever. Rather than have the
	 * framework invent a title from rules, it calls the pi agent itself via
	 * `generateSessionTitle` — a small, isolated model round-trip on the
	 * Session's own provider/model.
	 *
	 * Guarded so it only fires once: it's a no-op for anything that isn't a
	 * `session`-kind Session (an orchestrator Session keeps its fixed
	 * "Orchestrator" title) and for any Session whose title has already been
	 * replaced (i.e. is no longer the `defaultSessionTitle` placeholder).
	 * Because the placeholder guard is what makes it idempotent, a failed
	 * derivation on the first turn naturally retries on a later turn — it merely
	 * stays on the placeholder until one succeeds.
	 */
	private async maybeDeriveTitle(
		session: Session,
		firstPrompt: string,
	): Promise<void> {
		if (session.kind !== "session") return;
		if (session.title !== defaultSessionTitle(session.id)) return;
		const title = await generateSessionTitle(
			session.id,
			firstPrompt,
			session.provider,
			session.model,
		);
		if (!title) return;
		await this.setTitle(session.id, title);
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
	 * process died. Unlike Claude's file-backed transcript, pi's in-process
	 * `Agent` keeps no independent record of that turn — there is nothing to
	 * backfill (an accepted regression vs. Claude's crash-recovery guarantee,
	 * see ADR-0020's Consequences). The user's own message still survives
	 * either way: promote its pending placeholder to a permanent row rather
	 * than losing it — a restart must never delete the user's message, even
	 * though the assistant's response to it is gone.
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
			this.promotePendingUserMessage(row.id);
		}
		db.update(sessionsTable)
			.set({ status: "idle" })
			.where(inArray(sessionsTable.status, interrupted))
			.run();
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

	/**
	 * The session's most recent `turn_failed`, best-effort only: in-memory
	 * (per ADR-0016 §2, deliberately not persisted), cleared by the next
	 * accepted turn or lost on server restart. Callers that need failure
	 * detail to survive past that window must capture it while it's here —
	 * e.g. a transcript export taken before the session's next turn runs.
	 */
	getLastTurnFailed(
		id: string,
	): Extract<AgentStreamEvent, { type: "turn_failed" }> | undefined {
		const ev = this.lastTurnFailed.get(id);
		return ev?.type === "turn_failed" ? ev : undefined;
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

			// Best-effort, fire-and-forget: on a Session's very first turn, ask
			// the pi agent itself for a short title derived from this first
			// prompt, replacing the generic framework placeholder the moment it's
			// ready. Fired without awaiting so it never delays the real turn
			// (`maybeDeriveTitle`'s tiny isolated model call runs in parallel to
			// it), and any failure is logged and swallowed — the Session simply
			// keeps its placeholder until a later turn retries it.
			this.maybeDeriveTitle(session, text).catch((err) => {
				console.error(
					`[sessions] title derivation for ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});

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
				//
				// The turn never dispatched to the agent, so the user's message
				// exists only as the `pending-user-<id>` placeholder written by
				// `beginTurn`. Promote it to a permanent row (same rule as the
				// `spawn_failure` path and the normal-end `persistedUserMessage`
				// fallback): dropping it here would violate ADR-0014's
				// "never delete the user's message". Leaving the stable
				// `pending-user-<id>` id in place is what makes the *next*
				// turn's `beginTurn` INSERT collide on the messages primary key,
				// rejecting the user's next send.
				this.promotePendingUserMessage(id);
				await this.transitionStatus(id, "idle");
				this.armIdleTimer(id, active);
				return;
			}

			const handle = active.handle;
			// TURN_TIMEOUT_MS is a stall watchdog, not a hard cap on turn length —
			// bumped on every event so a turn that's actively streaming text or
			// running tools (including a long-running background task the agent
			// is synchronously waiting on) isn't killed mid-flight just because
			// its total wall-clock time crossed the threshold. Only genuine
			// silence — no event of any kind for TURN_TIMEOUT_MS — trips it.
			let stallTimer: NodeJS.Timeout | undefined;
			let rejectStalled: (err: TurnTimeoutError) => void = () => {};
			const bumpStallTimer = () => {
				if (stallTimer) clearTimeout(stallTimer);
				stallTimer = setTimeout(
					() => rejectStalled(new TurnTimeoutError()),
					TURN_TIMEOUT_MS,
				);
			};
			const stallTimeout = new Promise<never>((_, reject) => {
				rejectStalled = reject;
				bumpStallTimer();
			});
			const onEvent = (ev: AgentStreamEvent) => {
				bumpStallTimer();
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
				const outgoing = this.accumulateSessionUsage(id, ev, handle);
				if (outgoing.type === "turn_failed") {
					this.lastTurnFailed.set(id, outgoing);
				} else if (outgoing.type === "turn_activity") {
					this.lastTurnActivity.set(id, outgoing);
				} else if (outgoing.type === "notice") {
					this.lastNotice.set(id, outgoing);
				}
				this.broadcast(id, outgoing);
			};

			let timedOut = false;
			let crashed = false;
			let crashMessage = "";
			try {
				await Promise.race([
					chatPi(handle, {
						message: text,
						onEvent,
						abortSignal: turn.abortController.signal,
					}),
					stallTimeout,
				]);
			} catch (err) {
				if (err instanceof TurnTimeoutError) {
					timedOut = true;
					// The losing `chatPi` call above is abandoned, not cancelled —
					// it keeps running `agent.prompt()` in the background. Abort it
					// via the same signal `chatPi` is already listening on, so its
					// own post-await check sees `deliberatelyAborted` and skips
					// emitting a `turn_failed` once it eventually settles. Without
					// this, that stale call's `stopReason: "aborted"` (from the
					// unrelated `agent.abort()` `failTurn`→`markCrashed` triggers
					// below) would fire a second, late `turn_failed` through the
					// same `onEvent` closure — bypassing `failTurn`'s `terminalized`
					// guard entirely and potentially landing after a new turn has
					// already been accepted.
					turn.abortController.abort();
				} else {
					// pi's `Agent.prompt()` itself never rejects for an ordinary
					// provider/tool failure (see `chatPi`'s doc comment) — a
					// rejection here means the adapter itself broke unexpectedly.
					crashed = true;
					crashMessage = err instanceof Error ? err.message : String(err);
				}
			} finally {
				clearTimeout(stallTimer);

				// Persist everything this turn produced that we don't already
				// have. The placeholder is only dropped once the turn's real user
				// row landed; a turn that produced nothing (e.g. an immediate
				// adapter crash) promotes it instead — the user's message must
				// survive every failure mode (ADR-0014).
				let persistedUserMessage = false;
				try {
					const result = await this.persistMessagesFromAgent(
						id,
						handle,
						active.persistedCount,
					);
					persistedUserMessage = result.persistedUserMessage;
					// Only advance past this turn's entries once they're actually
					// durable — on a thrown persistence failure (below),
					// `active.persistedCount` stays put so the same entries are
					// retried as part of the *next* turn's slice instead of being
					// silently skipped forever (persistConverted's id-based dedup
					// makes a wider, overlapping retry slice safe).
					active.persistedCount = result.newPersistedCount;
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

				if (timedOut) {
					// The agent is stalled, not merely slow — route through the
					// same failure handling a genuine crash gets: drops the handle
					// from `active` so the next send spawns fresh instead of
					// reusing (and re-hanging on) this one, and gives the client an
					// explicit, visible signal instead of leaving it to infer
					// nothing is happening.
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
						message: `pi agent adapter error: ${crashMessage}`,
						detail: { stderrTail: handle.stderrTail.slice(-5) },
					});
				} else if (!turn.terminalized) {
					// Normal end of turn — and not already routed to a terminal
					// status by a racing stop-timeout escalation (see
					// requestStop/escalateStopTimeout) or a persistence failure
					// just above.

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

					// Compaction + context-usage reporting (ADR-0023): only for
					// ordinary Sessions — orchestrator Sessions (ADR-0021) are meant
					// to stay short/fire-and-forget. Failure here is logged and
					// swallowed, not routed through failTurn — the turn itself
					// already completed successfully; a missed check just gets
					// retried at the next turn's `agent_end`.
					if (session.kind === "session") {
						try {
							const { estimate, compaction } = await checkSessionContext(
								handle,
								await this.getMessages(id),
								sessionCompactionOf(session),
							);
							if (compaction) {
								// `checkSessionContext` replaced `handle.agent.state.messages`
								// wholesale with a reconstruction of already-persisted dilna
								// rows (plus a synthetic summary message) — none of it is new
								// data to persist, so the high-water mark must track the
								// replacement array's own length, not grow from its prior
								// value (see `ActiveAgent.persistedCount`'s doc comment).
								active.persistedCount = handle.agent.state.messages.length;
								getDb()
									.update(sessionsTable)
									.set({
										compactedSummary: compaction.summary,
										compactedThroughMessageId: compaction.throughMessageId,
									})
									.where(eq(sessionsTable.id, id))
									.run();
							}
							if (estimate) {
								this.broadcast(id, {
									type: "context_usage",
									tokens: estimate.tokens,
									contextWindow: estimate.contextWindow,
									reserveTokens: estimate.reserveTokens,
								});
							}
						} catch (err) {
							console.error(
								`[sessions] compaction/context check failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
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
	 * Stop the in-flight turn, if any (ADR-0016 §3). Aborts via `agent.abort()`
	 * (wired through `chatPi`'s `abortSignal`) rather than tearing the handle
	 * down — the `Agent` stays warm and reusable and the session lands
	 * `idle`, a clean ending with no `turn_failed`. No-op success when there
	 * is no turn in progress, and idempotent while stopping is already under
	 * way (a repeat call does not restart the escalation clock). Bounded by
	 * `STOP_TIMEOUT_MS`: if the turn hasn't reached a terminal status by
	 * then, `escalateStopTimeout` hard-stops it instead.
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
	 * Fold a turn-end `usage_update` into the session's lifetime token totals,
	 * and record the turn's full usage (tokens + cache + cost) as one
	 * `usage_events` row for the usage dashboard (`sessions/usageStats.ts`).
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
	 *
	 * `usage_events` deliberately only ever stores the token-only fields
	 * that already exist on `sessions` plus the extra cache/cost fields —
	 * it never reads back from `sessions`, so it's unaffected by the
	 * rewrite below.
	 */
	private accumulateSessionUsage(
		sessionId: string,
		ev: AgentStreamEvent,
		handle: PiHandle,
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
				repoId: sessionsTable.repoId,
			})
			.from(sessionsTable)
			.where(eq(sessionsTable.id, sessionId))
			.get();
		if (!row) return ev;

		db.insert(usageEventsTable)
			.values({
				id: nanoid(),
				sessionId,
				repoId: row.repoId,
				provider: handle.provider || "unknown",
				model: handle.model || "unknown",
				inputTokens: ev.cumulative.inputTokens,
				outputTokens: ev.cumulative.outputTokens,
				cacheReadTokens: ev.cumulative.cacheReadTokens ?? 0,
				cacheWriteTokens: ev.cumulative.cacheWriteTokens ?? 0,
				reasoningTokens: ev.cumulative.reasoningTokens ?? 0,
				costUsd: ev.cumulative.costUsd ?? 0,
			})
			.run();

		return {
			...ev,
			cumulative: {
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
			},
		};
	}

	/**
	 * Persist this turn's new entries off `handle.agent.state.messages`
	 * (everything from `persistedCount` onward — the caller's
	 * `active.persistedCount`, the high-water mark of what's already durably
	 * persisted; see `ActiveAgent.persistedCount`'s doc comment for why this
	 * isn't just "however many messages existed before this turn started").
	 * Unlike Claude's transcript file, this is already complete and
	 * authoritative the moment `chatPi`'s `agent.prompt()` call resolves — no
	 * transcript-write-lag retry poll needed (ADR-0007's "read complete
	 * authoritative state after the turn" pattern, sourced from in-process
	 * state instead of a re-read file). Returns whether a user-role row was
	 * among the freshly persisted ones — the caller uses that to decide the
	 * pending-user placeholder's fate (drop vs promote, see runTurn) — and
	 * the new high-water mark for the caller to advance `persistedCount` to,
	 * but only once persistence has actually succeeded.
	 */
	private async persistMessagesFromAgent(
		sessionId: string,
		handle: PiHandle,
		persistedCount: number,
	): Promise<{ persistedUserMessage: boolean; newPersistedCount: number }> {
		const newEntries = handle.agent.state.messages.slice(persistedCount);
		const { persistedUserMessage } = await this.persistConverted(
			sessionId,
			piMessagesToDilna(sessionId, newEntries),
		);
		return {
			persistedUserMessage,
			newPersistedCount: handle.agent.state.messages.length,
		};
	}

	/** Persist every converted turn row dilna doesn't already have. */
	private async persistConverted(
		sessionId: string,
		converted: Message[],
	): Promise<{ persistedUserMessage: boolean }> {
		const persisted = await this.getMessages(sessionId);
		const existing = new Set(persisted.map((m) => m.id));
		const fresh = converted.filter((msg) => !existing.has(msg.id));
		if (fresh.length === 0) return { persistedUserMessage: false };

		// Rows persisted before the past-stamping fix (a legacy claude.ts-era
		// artifact) can carry timestamps minutes in the future; shift this
		// batch above them so createdAt ordering stays monotonic for legacy
		// sessions (drift then shrinks to nothing as wall clock catches up).
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

		// The pending placeholder row (written at send time) still wins for
		// its exact createdAt when it doesn't break monotonic ordering, so a
		// client that already rendered the placeholder doesn't see it jump
		// position on reload — its *id* is always dropped below regardless
		// (a fresh id from piMessagesToDilna takes its place).
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
	 * Hard-stop the underlying agent for a session. Broadcasts a
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

		const inFlight = this.starting.get(id);
		if (inFlight) return inFlight;

		const promise = this.startAgent(id, session).finally(() => {
			this.starting.delete(id);
		});
		this.starting.set(id, promise);
		return promise;
	}

	/**
	 * Actually spawns the agent for `id`. Only ever called through
	 * `ensureStarted`'s singleflight guard — see `starting`.
	 *
	 * Every cold start — first turn ever, post-idle-kill respawn,
	 * post-server-restart — looks exactly like this: reconstruct
	 * `AgentMessage[]` from dilna's own already-durable persisted history and
	 * seed a freshly-constructed `Agent` with it. There is no separate
	 * "resume by id" branch the way Claude's transcript-backed resume needed
	 * — pi keeps no external transcript of its own to resume from (see
	 * `pi.ts`'s `PiStartOptions.initialMessages` doc comment).
	 */
	private async startAgent(id: string, session: Session): Promise<ActiveAgent> {
		await this.transitionStatus(id, "starting");

		// Anything other than "pi" is rejected outright — see `create()`'s
		// identical guard.
		if (session.agentType !== "pi") {
			throw new Error(`${session.agentType} agent backend is not implemented`);
		}

		// The pending-user placeholder for *this* turn (persisted by
		// beginTurn, before ensureStarted/startAgent ever runs) is not prior
		// context — chatPi sends its own text as the new prompt, so including
		// it here would duplicate it in the agent's seeded context.
		const pendingId = this.pendingUserMessageId(id);
		const history = (await this.getMessages(id)).filter(
			(m) => m.id !== pendingId,
		);
		const initialMessages = buildInitialMessages(
			history,
			sessionCompactionOf(session),
		);

		const handle: PiHandle =
			session.kind === "orchestrator"
				? await startOrchestrator({
						sessionId: id,
						worktreePath: session.worktreePath,
						provider: session.provider,
						model: session.model,
						initialMessages,
						deps: this.buildOrchestratorDeps(id),
					})
				: await startPi({
						sessionId: id,
						worktreePath: session.worktreePath,
						repoId: session.repoId,
						provider: session.provider,
						model: session.model,
						initialMessages,
					} satisfies PiStartOptions);

		const active: ActiveAgent = {
			handle,
			idleTimer: null,
			liveTurn: null,
			persistedCount: initialMessages.length,
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
	 * Arm the idle-kill timer once a turn ends. `pi.ts` has no background-work
	 * or scheduled-wakeup surface (ADR-0020's accepted capability gap vs.
	 * Claude's Stop-hook-reported `background_tasks`/`session_crons` — see
	 * this migration's Out of Scope), so — unlike the Claude-era version of
	 * this method — there is nothing to defer to; every turn end arms the
	 * countdown unconditionally.
	 */
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
		if (!active || this.turnsInProgress.has(id)) return;
		await this.stopSession(id);
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
}

export const sessionManager = new SessionManager();
