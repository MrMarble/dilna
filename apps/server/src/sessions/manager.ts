import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
	AgentStreamEvent,
	AgentType,
	Attachment,
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
	type AgentEvent,
	chatPi,
	generateSessionTitle,
	type OrchestratorDeps,
	type PiHandle,
	type PiStartOptions,
	piMessagesToDilna,
	piRoundToDilnaMessage,
	startOrchestrator,
	startPi,
} from "../agents/pi";
import {
	effectiveModel,
	effectiveProvider,
} from "../agents/providerConfigStore";
import {
	type AgentImageInput,
	IDLE_TIMEOUT_MS,
	STOP_TIMEOUT_MS,
	TURN_TIMEOUT_MS,
} from "../agents/types";
import { getDb } from "../db";
import {
	rateLimits as rateLimitsTable,
	sessions as sessionsTable,
} from "../db/schema";
import { logger } from "../logger";
import { RepoNotFoundError, repoManager } from "../repos/manager";
import {
	archiveSession as archiveSessionRow,
	getArchivedSession,
	listArchivedSessions,
} from "./archive";
import {
	deleteAttachmentsForSession,
	describeAttachmentsForPrompt,
	describeAttachmentsForTitle,
} from "./attachments";
import { type Listener, SessionBroadcaster } from "./broadcaster";
import {
	buildInitialMessages,
	checkSessionContext,
	estimateSessionContext,
	summarizeSessionForArchive,
} from "./context";
import { computeChangedFiles } from "./diff";
import {
	applyEventToLiveTurn,
	type LiveTurn,
	liveTurnReplayEvents,
} from "./liveTurn";
import * as messageStore from "./messageStore";
import { isTurnCompletion, notifyTurnComplete } from "./pushSender";
import { freshRateLimitWindows, type RateLimitSnapshot } from "./rateLimits";
import {
	defaultSessionTitle,
	rowToSession,
	sessionCompactionOf,
	toView,
} from "./sessionStore";
import { type Turn, TurnRegistry } from "./turnRegistry";
import { accumulateSessionUsage } from "./usageAccounting";
import {
	createWorktree,
	initCodegraph,
	recentCommits,
	removeWorktree,
} from "./worktree";

const log = logger.child({ component: "sessions/manager" });

// The live-turn snapshot helpers moved to ./liveTurn (issue #149); re-exported
// here because they're part of this module's established public surface.
export {
	applyEventToLiveTurn,
	type LiveTurn,
	liveTurnReplayEvents,
} from "./liveTurn";

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

/** Thrown by `beginTurn` once `drain()` has started (ADR-0026) — distinguished
 * from the "already in progress" 409 so the route can map it to its own,
 * client-retryable status (503) instead. */
export class SessionManagerDrainingError extends Error {
	constructor() {
		super("server is shutting down");
		this.name = "SessionManagerDrainingError";
	}
}

/** Thrown by `beginTurn` when the session already has a turn in progress —
 * distinguished so the route maps *only* this to 409, instead of falling
 * back to 409 for any other unexpected error (e.g. a real DB failure). */
export class TurnInProgressError extends Error {
	constructor() {
		super("session already has a chat in progress");
		this.name = "TurnInProgressError";
	}
}

type TurnFailedClass = Extract<
	AgentStreamEvent,
	{ type: "turn_failed" }
>["class"];

type ActiveAgent = {
	handle: PiHandle;
	idleTimer: NodeJS.Timeout | null;
	/** Snapshot of the in-flight turn's assistant message, replayed to
	 * subscribers that connect mid-turn (see {@link LiveTurn}). Null between
	 * turns — cleared after the turn's rows are persisted. */
	liveTurn: LiveTurn | null;
	/**
	 * How far into `handle.agent.state.messages` dilna has already *examined*
	 * — the slice boundary `runTurn` reads a turn's new entries from (see
	 * `persistMessagesFromAgent`). A position, not a success counter:
	 * {@link ActiveAgent.persistedRounds} is what records which of those
	 * entries actually reached the DB.
	 *
	 * Keeping the two separate matters (issue #190). When this doubled as a
	 * "successfully persisted" counter, a round whose incremental write threw
	 * left it unadvanced while *later* rounds still advanced it — so it came
	 * to point past the failed round rather than at it. The turn-end slice
	 * then started mid-transcript: it re-offered an already-persisted round
	 * (which, the two converters minting different ids, inserted a duplicate
	 * row) and never re-offered the failed one at all.
	 *
	 * On a whole-turn persistence failure this still stays put, so the turn's
	 * entries are retried as part of turn N+1's slice instead of being
	 * silently skipped once `state.messages` has moved past them.
	 * Initialized in `startAgent` to the length of the seeded
	 * `initialMessages` (dilna's own persisted history) — everything at or
	 * before that point is already in the DB by construction. */
	persistedCount: number;
	/**
	 * The assistant entries whose rows the *incremental* path
	 * (`persistRoundEvent`) already wrote for the in-flight turn, held by
	 * object identity — these are the very `AgentMessage` objects sitting in
	 * `handle.agent.state.messages`, so identity is exact and needs no
	 * content hashing or index arithmetic.
	 *
	 * Exists because `persistedCount` alone cannot express the overlap
	 * (issue #190): it is a single high-water mark, so one round failing to
	 * persist pins it behind *every* later round, and the turn-end safety
	 * net's retry slice then re-offers rounds that already landed. Dedup in
	 * `persistConverted` is id-based and both converters mint fresh UUIDs, so
	 * those re-offered rounds would insert as duplicate assistant rows. This
	 * set is what lets the safety net offer only the genuine gap.
	 *
	 * A `WeakSet` so abandoned transcript entries — a stalled turn's
	 * background `chatPi` call, or a compaction that replaces
	 * `state.messages` wholesale — can still be garbage collected. */
	persistedRounds: WeakSet<object>;
};

/**
 * Owns the Session lifecycle: worktree creation, spawning/resuming the agent
 * process, the turn state machine, and idle-timeout kill.
 *
 * Issue #149 pulled the responsibilities that were merely *co-located* here
 * into collaborators this class composes rather than owns the state of:
 *
 * - `messageStore` — every `messages` read/write, including the pending-user
 *   placeholder protocol.
 * - {@link SessionBroadcaster} — subscriber bookkeeping, event fan-out, and
 *   the retained events that make up ADR-0016 §4's opening snapshot.
 * - {@link TurnRegistry} — turn-slot claim/release and ADR-0026 draining.
 * - `./worktree` — the git shell-outs.
 * - `./usageAccounting`, `./sessionStore`, `./liveTurn` — usage rows, row
 *   mapping, and the live-turn fold.
 *
 * What deliberately stayed: `runTurn` and everything it coordinates. The
 * turn state machine's correctness properties (exactly one terminal status
 * per turn, exactly one `turn_failed` on failure, the ordering between
 * persistence and status transitions) are properties of the *sequence*, not
 * of any one step, so splitting the sequence across objects would spread a
 * single invariant over several files without making any of them simpler.
 */
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
	/** Subscriber bookkeeping and event fan-out (see {@link SessionBroadcaster}). */
	private events = new SessionBroadcaster();
	/** Turn-slot claims and graceful-shutdown tracking (see {@link TurnRegistry}). */
	private turns = new TurnRegistry();
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

	/** Register an in-flight `runTurn` call so `drain()` can wait on it — see
	 * {@link TurnRegistry.track} for why every call site must do this rather
	 * than fire-and-forget. */
	trackRunningTurn(id: string, promise: Promise<void>): void {
		this.turns.track(id, promise);
	}

	/** Graceful shutdown (ADR-0026) — see {@link TurnRegistry.drain}. */
	async drain(timeoutMs: number): Promise<void> {
		await this.turns.drain(timeoutMs);
	}

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
								(p): p is Extract<Message["parts"][number], { type: "text" }> =>
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
				const turnPromise = this.runTurn(view.id, prompt);
				this.trackRunningTurn(view.id, turnPromise);
				turnPromise.catch((err) => {
					log.error(
						{ sessionId: view.id, err },
						"orchestrator-spawned runTurn failed",
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
	 * The provider/model to attribute a Session's work to. A live Session's
	 * already-running `Agent` captured its provider/model at construction
	 * (`PiHandle.provider`/`.model`); an idle one has none, so this falls
	 * back to its own create-time snapshot and then to whatever's currently
	 * configured — the same resolution `startAgent` would use if the Session
	 * resumed right now (see `PiHandle`'s doc comment on why a long-lived
	 * live Session can drift from that).
	 */
	private resolveProviderModel(session: Session): {
		provider: string;
		model: string;
	} {
		const active = this.active.get(session.id);
		return {
			provider: active
				? active.handle.provider
				: (session.provider ?? effectiveProvider()),
			model: active ? active.handle.model : (session.model ?? effectiveModel()),
		};
	}

	/**
	 * `GET /api/sessions/:id`'s `contextUsage` field (ADR-0023's addendum) —
	 * lets a page load/session switch show a Session's context occupancy
	 * immediately, rather than the sidebar meter staying blank until the next
	 * `context_usage` broadcast (which only fires at an in-progress turn's
	 * end). `null` for an orchestrator Session (no compaction, no model
	 * concept meaningful to report) or one whose provider/model has since
	 * fallen out of dilna's catalog.
	 */
	async getContextUsageEstimate(
		id: string,
	): Promise<ContextUsageEstimate | null> {
		const session = await this.get(id);
		if (session?.kind !== "session") return null;

		const { provider, model } = this.resolveProviderModel(session);
		const pendingId = messageStore.pendingUserMessageId(id);
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
		if (!repo) throw new RepoNotFoundError(repoId);

		const id = nanoid();
		const branchName = `dilna/${id}`;
		const worktreeDirName = id;
		const worktreePath = path.join(
			repoManager.worktreeBase(repo.slug),
			worktreeDirName,
		);

		await createWorktree({
			repoPath: repo.path,
			worktreePath,
			branchName,
			baseBranch: repo.defaultBranch,
		});
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

		try {
			getDb()
				.insert(sessionsTable)
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
		} catch (err) {
			// Don't leak the worktree/branch just created above if the row
			// insert fails (e.g. a DB error) — clean up the git side effect
			// before rethrowing.
			await removeWorktree({
				repoPath: repo.path,
				worktreePath,
				branchName,
			});
			throw err;
		}

		const view = toView(session);
		this.events.broadcastGlobal({ type: "session_status", session: view });
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
		// `.model`).
		const { provider, model } = this.resolveProviderModel(session);

		// Kill any running agent first.
		await this.stopSession(id);

		// Archive before destroying (ADR-0024) — ordinary Sessions only;
		// orchestrator ones have no coding content worth referencing later,
		// same exclusion as ADR-0023's compaction.
		if (session.kind === "session") {
			await this.archiveBeforeDelete(session, provider, model);
		}

		const repo = await repoManager.get(session.repoId);
		await removeWorktree({
			repoPath: repo?.path ?? null,
			worktreePath: session.worktreePath,
			branchName: session.branchName,
		});

		const db = getDb();
		db.transaction(() => {
			messageStore.deleteMessagesForSession(id);
			db.delete(sessionsTable).where(eq(sessionsTable.id, id)).run();
		});
		// Outside the transaction above because it also removes the Session's
		// attachment directory from disk (issue #53) — a filesystem effect a
		// rollback couldn't undo anyway. Deleting the Session is the only thing
		// that prunes attachments at all; see the schema's table comment.
		deleteAttachmentsForSession(id);
		this.events.broadcastGlobal({ type: "session_deleted", sessionId: id });
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
			log.error(
				{ sessionId: session.id, err },
				"archival failed, deleting without an archive",
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
		if (view) {
			this.events.broadcastGlobal({ type: "session_status", session: view });
		}
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

	/**
	 * Returns the post-write {@link SessionView} it already had to build for the
	 * global broadcast, so callers needing the session don't re-read it —
	 * `transitionStatus` runs on every status change and is squarely on the
	 * session hot path.
	 */
	async setStatus(
		id: string,
		status: Session["status"],
	): Promise<SessionView | null> {
		const db = getDb();
		const now = Math.floor(Date.now() / 1000);
		db.update(sessionsTable)
			.set({ status, lastActiveAt: now })
			.where(eq(sessionsTable.id, id))
			.run();
		const view = await this.getView(id);
		if (view) {
			this.events.broadcastGlobal({ type: "session_status", session: view });
		}
		return view;
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
		// The pre-write status has to come from the DB: the in-memory `active`
		// registry isn't a substitute, because `stopSession`/`markCrashed` remove
		// their entry *before* transitioning, which would read as "no turn was
		// running". `setStatus` returns the post-write view it already built, so
		// this funnel costs one extra read rather than the three an earlier cut
		// of this code paid.
		const previous = (await this.get(id))?.status;
		const view = await this.setStatus(id, status);
		this.events.broadcast(id, { type: "session_status", status });
		if (view) this.maybeNotifyTurnComplete(view, previous, status);
	}

	/**
	 * Fire a Web Push notification when a turn actually completes (ADR-0029).
	 *
	 * "Completes" is the same rule the in-page client uses
	 * (`useSessionNotifications`): a transition *out of* an active phase into
	 * `idle`. `transitionStatus` runs for every status change, so without the
	 * `previous` check this would also fire on `idle → idle` re-writes (e.g.
	 * `stopSession` on an already-stopped session) and notify about turns that
	 * never ran.
	 *
	 * `crashed` deliberately does not notify, matching the client: a crashed
	 * session is already conspicuous via the sidebar's red dot, and a push
	 * saying "finished the turn" would be actively misleading.
	 *
	 * Fire-and-forget: push delivery is best-effort and must never delay or
	 * fail a status transition on the session hot path.
	 */
	private maybeNotifyTurnComplete(
		session: SessionView,
		previous: Session["status"] | undefined,
		next: Session["status"],
	): void {
		if (!isTurnCompletion(previous, next)) return;
		void notifyTurnComplete(session.id, session.title).catch((error) => {
			logger.warn({ sessionId: session.id, err: error }, "push notify failed");
		});
	}

	/**
	 * Boot-time recovery (ADR-0014, hardened by ADR-0026). Any session still
	 * marked working/starting/stopping had a turn in flight when the previous
	 * server process died. Unlike Claude's file-backed transcript, pi's
	 * in-process `Agent` keeps no independent record of that turn — there is
	 * nothing to backfill beyond whatever incremental per-round persistence
	 * (ADR-0026) already landed before the interruption (an accepted
	 * regression vs. Claude's crash-recovery guarantee, see ADR-0020's
	 * Consequences). The user's own message still survives either way:
	 * promote its pending placeholder to a permanent row rather than losing
	 * it — a restart must never delete the user's message, even though the
	 * rest of the assistant's response to it may be gone.
	 *
	 * ADR-0026 also adds a durable, visible marker: a synthetic `role:
	 * "system"` row explaining the interruption, so a client that reconnects
	 * long after the fact (nobody was necessarily watching when the process
	 * died) sees *why* the turn stops abruptly instead of silent nothing.
	 * This is a deliberate, narrow departure from ADR-0016's `notice` event,
	 * which is explicitly transient/non-persisted by design for a different
	 * problem (a live, in-turn hint to an already-connected client) — that
	 * decision is untouched; this is a new, distinct concept scoped to
	 * boot-time interruption recovery only.
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
			messageStore.promotePendingUserMessage(row.id);
			messageStore.persistMessage(row.id, {
				id: nanoid(),
				sessionId: row.id,
				role: "system",
				parts: [
					{
						type: "text",
						text: "This turn was interrupted before it could finish — the server restarted mid-response. Your message was saved; you can try again.",
					},
				],
				// A boot-time notice is nobody's turn — never grouped (ADR-0026 §2).
				turnId: null,
				createdAt: Math.floor(Date.now() / 1000),
			});
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
		return this.events.subscribeAll(listener);
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
	 * is registered, and is first given ADR-0016 §4's opening snapshot:
	 * whatever a client watching all along would currently have on screen.
	 */
	subscribe(id: string, listener: Listener): () => void {
		const unsubscribe = this.events.subscribe(id, listener);

		// Snapshot rule (ADR-0016 §4): reproduce what a live viewer of the
		// current state would have seen. The last `turn_failed` (while still
		// current — cleared by the next accepted turn) always precedes the
		// opening status, preserving §2's "failure event precedes terminal
		// status" ordering for a subscriber who missed the original broadcast.
		const lastFailed = this.events.getLastTurnFailed(id);
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
		const inProgress = this.turns.has(id);
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
			for (const ev of this.events.midTurnSnapshot(id)) listener(ev);
			if (active.liveTurn) {
				for (const ev of liveTurnReplayEvents(active.liveTurn)) {
					listener(ev);
				}
			}
		}
		return unsubscribe;
	}

	/**
	 * True if the session currently has a turn in flight. Backed by the
	 * {@link TurnRegistry}, claimed synchronously by `beginTurn` before any
	 * `await` — see that method's doc comment for why this is what makes the
	 * pre-202 409 the only duplicate-send surface (ADR-0016 §2).
	 */
	isChatInProgress(id: string): boolean {
		return this.turns.has(id);
	}

	/**
	 * The session's most recent `turn_failed`, best-effort only — see
	 * {@link SessionBroadcaster.getLastTurnFailed}.
	 */
	getLastTurnFailed(
		id: string,
	): Extract<AgentStreamEvent, { type: "turn_failed" }> | undefined {
		return this.events.getLastTurnFailed(id);
	}

	async getMessages(id: string): Promise<Message[]> {
		return messageStore.getMessages(id);
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
	 * Most recent commits reachable from the Session's Worktree HEAD, for the
	 * context panel. Read live from git like getChangedFiles — never
	 * persisted. Soft-fails to [] (e.g. worktree deleted out from under the
	 * session).
	 */
	async getRecentCommits(id: string, limit = 5): Promise<CommitInfo[]> {
		const session = await this.get(id);
		if (!session) return [];
		return recentCommits(session.worktreePath, limit);
	}

	/**
	 * Claim the turn slot and persist the user's message — synchronously, with
	 * no `await` between the 409 check and the claim. This is the fix for
	 * ADR-0016 §2's post-202 duplicate-send race: the old check (in what is
	 * now `runTurn`) happened after an `await ensureStarted(...)`, so a fast
	 * second POST could pass the same check before the first request's claim
	 * ever landed, and both would get their own 202. The turn slot is claimed
	 * here instead — before `runTurn`'s spawn even starts — making the
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
	 *
	 * `attachments` are already-uploaded files this message carries (issue
	 * #53), resolved and ownership-checked by the route before it gets here.
	 * They become `attachment` parts on the persisted user row, so the message
	 * renders with its files on every future reload — the same row the 202 and
	 * the `user_message` broadcast echo, so no client has to merge them in
	 * separately.
	 */
	beginTurn(id: string, text: string, attachments: Attachment[] = []): Message {
		if (this.turns.isDraining()) {
			throw new SessionManagerDrainingError();
		}
		if (this.turns.has(id)) {
			throw new TurnInProgressError();
		}
		const row = getDb()
			.select({ id: sessionsTable.id })
			.from(sessionsTable)
			.where(eq(sessionsTable.id, id))
			.get();
		if (!row) throw new SessionNotFoundError();

		if (!this.turns.claim(id)) throw new TurnInProgressError();
		// A `turn_failed` is only "current" until the next accepted turn
		// (ADR-0016 §4's snapshot rule); `turn_activity`/`notice` are valid
		// only inside the turn that's about to start.
		this.events.clearTurnSnapshot(id);

		const message: Message = {
			id: messageStore.pendingUserMessageId(id),
			sessionId: id,
			role: "user",
			// Attachments lead: the chat renders them above the text (matching
			// every composer that stacks a file tray over its input), and a
			// consumer that only reads the first text part is unaffected either
			// way. An attachment-only message ("look at this") contributes no
			// text part at all rather than an empty one — every consumer already
			// handles a message whose parts are not all text, and an empty string
			// would render as a blank line under the files.
			parts: [
				...attachments.map(
					(attachment): MessagePart => ({ type: "attachment", attachment }),
				),
				...(text ? [{ type: "text" as const, text }] : []),
			],
			// The user's row is never grouped with the reply that answers it —
			// a turn has exactly one user row, and the assistant rows it
			// produces are the ones `turnId` exists to regroup.
			turnId: null,
			createdAt: Math.floor(Date.now() / 1000),
		};
		messageStore.persistMessage(id, message);
		this.events.broadcast(id, { type: "user_message", message });
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
	async runTurn(
		id: string,
		text: string,
		attachments: Attachment[] = [],
	): Promise<void> {
		const turn = this.turns.get(id);
		if (!turn) {
			log.error(
				{ sessionId: id },
				"runTurn invoked with no claimed turn — dropping",
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
			//
			// Attachment filenames are folded in (issue #53) because a first turn
			// can legitimately have no text at all ("look at this" with just a
			// screenshot) — deriving a title from `""` gives the model nothing to
			// work with. See `describeAttachmentsForTitle` for why this isn't the
			// same string the Agent gets.
			const titlePrompt = describeAttachmentsForTitle(text, attachments);
			this.maybeDeriveTitle(session, titlePrompt).catch((err) => {
				log.error({ sessionId: id, err }, "title derivation failed");
			});

			let active: ActiveAgent;
			try {
				active = await this.ensureStarted(id, session);
			} catch (err) {
				// Nothing spawned — the placeholder can only be promoted, never
				// resolved from a transcript.
				messageStore.promotePendingUserMessage(id);
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
				messageStore.promotePendingUserMessage(id);
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
				// The broadcaster retains the snapshot-relevant events
				// (turn_failed/turn_activity/notice) on the way out — see
				// SessionBroadcaster.record.
				this.events.broadcast(id, accumulateSessionUsage(id, ev, handle));
			};

			// Incremental persistence (ADR-0026): a raw pi-agent-core subscription,
			// independent of the normalized `onEvent` stream above — see
			// `persistRoundEvent`'s doc comment for what it does and why.
			// `turnSettled` mirrors the existing `deliberatelyAborted` guard on the
			// stall-timeout path below: a stalled turn's abandoned background
			// `chatPi` call keeps running after this turn has already been given up
			// on, and any round it completes after that point must not touch
			// `active.persistedCount` — that content isn't lost, it's simply left
			// for the next turn's wider, overlapping retry slice to pick up instead
			// (same fallback `persistRoundEvent`'s own persist-failure catch
			// already relies on).
			let turnSettled = false;
			const unsubscribeRounds = handle.agent.subscribe((event) => {
				if (!turnSettled) this.persistRoundEvent(id, active, event, turnId);
			});

			// The id that groups every row this turn produces (`Message.turnId`).
			// Minted once here, at the turn's own scope, and stamped on every
			// path that writes this turn's rows — the incremental per-round
			// `persistRoundEvent` below and the turn-end safety net — so the web
			// client regroups them into the one message the live view already
			// shows, instead of N messages per round after a reload (ADR-0026 §3).
			// Deliberately *not* `handle.agent`/`NormalizeState.currentMessageId`:
			// that id is minted lazily by the normalizer on the first assistant
			// frame and can legitimately be absent (a turn that failed before any
			// content), whereas this must exist for every round the turn writes.
			const turnId = randomUUID();

			// Attachments reach the Agent through two channels (issue #53): every
			// file's on-disk path is named in a preamble ahead of the user's own
			// text, and images *additionally* travel inline as base64 so the
			// Provider can actually see them. The preamble covers images too —
			// being shown a picture doesn't tell the Agent where the file is, and
			// "crop this and save it" needs the path.
			//
			// Read here rather than at `beginTurn` so a cold-start spawn isn't
			// holding every attachment's bytes in memory while it waits, and a
			// file that vanished between upload and dispatch degrades to "the
			// preamble mentions it, the Agent's read fails" instead of failing
			// the turn before it starts.
			const preamble = describeAttachmentsForPrompt(attachments);
			const promptText = preamble ? `${preamble}\n\n${text}` : text;
			const images = attachments
				.filter((a) => a.kind === "image")
				.flatMap((a): AgentImageInput[] => {
					try {
						return [
							{
								data: readFileSync(a.path).toString("base64"),
								mimeType: a.mimeType,
							},
						];
					} catch (err) {
						// The path is still in the preamble, so the Agent can report
						// the file as unreadable rather than silently pretending it
						// saw a picture that never arrived.
						log.error(
							{ sessionId: id, attachmentId: a.id, err },
							"failed to read image attachment; sending path only",
						);
						return [];
					}
				});

			let timedOut = false;
			let crashed = false;
			let crashMessage = "";
			try {
				await Promise.race([
					chatPi(handle, {
						message: promptText,
						images,
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
				// Stop the incremental round listener from touching
				// `active.persistedCount` from here on — see its setup comment
				// above for why a stale background call can still fire after this
				// point, and why that's safe to just ignore.
				turnSettled = true;
				unsubscribeRounds();

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
						turnId,
						active.persistedRounds,
					);
					persistedUserMessage = result.persistedUserMessage;
					// Only advance past this turn's entries once they're actually
					// durable — on a thrown persistence failure (below),
					// `active.persistedCount` stays put so the same entries are
					// retried as part of the *next* turn's slice instead of being
					// silently skipped forever. `active.persistedRounds` keeps that
					// wider, overlapping slice from re-writing rounds that did land.
					active.persistedCount = result.newPersistedCount;
				} catch (err) {
					log.error({ sessionId: id, err }, "failed to persist turn messages");
					this.failTurn(id, turn, {
						class: "persistence_failure",
						message: `failed to persist turn messages: ${err instanceof Error ? err.message : String(err)}`,
					});
				}
				if (persistedUserMessage) {
					messageStore.deleteMessage(id, messageStore.pendingUserMessageId(id));
				} else {
					messageStore.promotePendingUserMessage(id);
				}
				// The turn's rows are now in the DB (or promoted) — the in-memory
				// snapshot has served its purpose. Cleared only after persisting so
				// a subscriber connecting in between never sees neither.
				active.liveTurn = null;
				// turn_activity/notice are valid only inside a turn (ADR-0016 §5).
				this.events.clearInTurnSnapshot(id);

				if (timedOut) {
					// The agent is stalled, not merely slow — route through the
					// same failure handling a genuine crash gets: drops the handle
					// from `active` so the next send spawns fresh instead of
					// reusing (and re-hanging on) this one, and gives the client an
					// explicit, visible signal instead of leaving it to infer
					// nothing is happening.
					log.error(
						{ sessionId: id, timeoutMs: TURN_TIMEOUT_MS },
						"turn exceeded timeout with no response — treating as crashed",
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
						this.events.broadcast(id, { type: "changed_files", files });
					} catch (err) {
						log.error(
							{ sessionId: id, err },
							"failed to compute changed files",
						);
					}

					await this.checkContextAndCompact(id, session, active);

					await this.transitionStatus(id, "idle");
					this.armIdleTimer(id, active);
				}
			}
		} finally {
			this.turns.release(id);
		}
	}

	/**
	 * Compaction + context-usage reporting at a turn's normal end (ADR-0023):
	 * only for ordinary Sessions — orchestrator Sessions (ADR-0021) are meant
	 * to stay short/fire-and-forget. Failure here is logged and swallowed,
	 * not routed through failTurn — the turn itself already completed
	 * successfully; a missed check just gets retried at the next turn's
	 * `agent_end`.
	 *
	 * The policy itself lives in `sessions/context.ts` (issue #175) and works
	 * purely over persisted history; this method is the lifecycle-side wiring
	 * around it — feed it the live handle's provider/model, then apply what it
	 * returns to the live `Agent`, the `sessions` row, and the SSE stream.
	 */
	private async checkContextAndCompact(
		id: string,
		session: Session,
		active: ActiveAgent,
	): Promise<void> {
		if (session.kind !== "session") return;
		try {
			const { estimate, compaction, newContext } = await checkSessionContext(
				active.handle.provider,
				active.handle.model,
				await this.getMessages(id),
				sessionCompactionOf(session),
			);
			if (compaction && newContext) {
				// Swap the live `Agent` over to the compacted context so *this*
				// Session shrinks immediately rather than only at its next cold
				// start. Done here rather than inside `checkSessionContext`
				// (which used to reach into the handle itself) because this is
				// the only layer that owns the live handle — and it has to touch
				// it either way for the high-water mark below.
				active.handle.agent.state.messages = newContext;
				// `newContext` is a reconstruction of already-persisted dilna
				// rows (plus a synthetic summary message) — none of it is new
				// data to persist, so the high-water mark must track the
				// replacement array's own length, not grow from its prior
				// value (see `ActiveAgent.persistedCount`'s doc comment).
				active.persistedCount = newContext.length;
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
				this.events.broadcast(id, {
					type: "context_usage",
					tokens: estimate.tokens,
					contextWindow: estimate.contextWindow,
					reserveTokens: estimate.reserveTokens,
				});
			}
		} catch (err) {
			log.error({ sessionId: id, err }, "compaction/context check failed");
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

		// The broadcaster retains this as the session's `lastTurnFailed` on the
		// way out (SessionBroadcaster.record), so it's still in the opening
		// snapshot for a client that subscribes after the fact.
		this.events.broadcast(id, { type: "turn_failed", ...failure });

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
		const turn = this.turns.get(id);
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
		const turn = this.turns.get(id);
		if (!turn || turn.terminalized) return;
		log.error(
			{ sessionId: id, stopTimeoutMs: STOP_TIMEOUT_MS },
			"stop did not complete within timeout — killing the process",
		);
		this.failTurn(id, turn, {
			class: "turn_timeout",
			message: `stop did not complete within ${STOP_TIMEOUT_MS / 1000}s with no response from the agent`,
		});
	}

	/**
	 * ADR-0026's incremental-persistence handler: one raw pi-agent-core event
	 * from `runTurn`'s dedicated `handle.agent.subscribe` (independent of the
	 * normalized `onEvent` stream), advancing `active.persistedCount` in step
	 * with `handle.agent.state.messages`'s real growth and persisting each
	 * completed round as its own row as soon as it's known-complete. Split out
	 * from `runTurn` as its own method purely so it's unit-testable without a
	 * real spawned `pi-agent-core` `Agent` — `runTurn` is still the only
	 * caller.
	 *
	 * Two event types matter here: `message_end` for the turn's own leading
	 * user-role entry (pi's `agent-loop.js` always pushes this, once, before
	 * any round starts — no DB write, dilna's own placeholder already covers
	 * it, this just keeps the index in sync) and `turn_end` (one per
	 * completed round — converts and persists via `piRoundToDilnaMessage`,
	 * stamped with the caller's per-turn `turnId` so every row this turn
	 * writes regroups as one message on reload).
	 * Every other event type is a no-op here. A persistence failure is caught
	 * and logged, not re-thrown into the agent's own event dispatch: the round
	 * simply isn't added to `active.persistedRounds`, which is what tells the
	 * turn-end safety net (`persistMessagesFromAgent`) to write it after all.
	 *
	 * `persistedCount` advances on *every* entry this sees, success or
	 * failure — it is a position in `handle.agent.state.messages`, not a
	 * success counter. Skipping the advance on failure (as this used to do)
	 * desynchronized it from the transcript: later rounds kept advancing it,
	 * so the mark ended up pointing *past* the failed round. The safety net's
	 * slice then began mid-transcript, re-offering a round that had already
	 * landed while never re-offering the one that hadn't — the duplicate half
	 * of issue #190, and a silent data-loss half alongside it. Which rounds
	 * are durable is now `persistedRounds`'s job exclusively.
	 */
	private persistRoundEvent(
		sessionId: string,
		active: ActiveAgent,
		event: AgentEvent,
		turnId: string,
	): void {
		if (event.type === "message_end" && event.message.role === "user") {
			active.persistedCount += 1;
			return;
		}
		if (event.type === "turn_end") {
			try {
				const message = piRoundToDilnaMessage(sessionId, event, turnId);
				if (message) messageStore.persistMessage(sessionId, message);
				// Marked done only *after* the write succeeded, so a throw above
				// leaves the round for the safety net. An empty round (null
				// message) is marked too: it has no row to write, and re-offering
				// it would only make the safety net re-derive the same nothing.
				active.persistedRounds.add(event.message);
			} catch (err) {
				log.error(
					{ sessionId, err },
					"failed to incrementally persist a round (will retry at turn end)",
				);
			} finally {
				active.persistedCount += 1 + event.toolResults.length;
			}
		}
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
	 *
	 * Rounds the incremental path already wrote are filtered out of the slice
	 * by entry identity, rather than left to `persistConverted`'s dedup, which
	 * is id-based and therefore blind to them: both converters mint fresh
	 * UUIDs for the same content, so an overlapping round would insert a
	 * second copy (issue #190). The overlap is real whenever a round's
	 * incremental write failed — that round is left out of `persistedRounds`
	 * while the rest of the turn's rounds are in it, so this slice legitimately
	 * spans both. `piMessagesToDilna` emits one row per round to match, which
	 * is what makes "skip exactly these rounds" expressible.
	 */
	private async persistMessagesFromAgent(
		sessionId: string,
		handle: PiHandle,
		persistedCount: number,
		turnId: string,
		persistedRounds: WeakSet<object>,
	): Promise<{ persistedUserMessage: boolean; newPersistedCount: number }> {
		const newEntries = handle.agent.state.messages
			.slice(persistedCount)
			.filter((entry) => !persistedRounds.has(entry));
		const { persistedUserMessage } = messageStore.persistConverted(
			sessionId,
			piMessagesToDilna(sessionId, newEntries, turnId),
		);
		return {
			persistedUserMessage,
			newPersistedCount: handle.agent.state.messages.length,
		};
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
		const pendingId = messageStore.pendingUserMessageId(id);
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
			persistedRounds: new WeakSet(),
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
		if (!active || this.turns.has(id)) return;
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
}

export const sessionManager = new SessionManager();
