import type { ModelRole, ModelRoleAssignment } from "./apiSchemas";
import type { Artefact } from "./artefact";
import type { ChangedFile } from "./diff";
import type { ContextUsageEstimate } from "./events";
import type { Attachment, Message, QueuedMessage } from "./messages";
import type { CommitInfo, Repo, RepoStats, RepoSyncStatus } from "./repo";
import type { TurnScore } from "./scoring";
import type { SessionView } from "./session";
import type { RepoSkill, Skill, SkillSearchResult } from "./skill";
import type { TrimReason } from "./toolOutputPolicy";
import type { DiskUsage, SessionBurnTurn, UsageSummary } from "./usage";

/**
 * Response envelopes for dilna's HTTP API — the `{ repos: [...] }` wrapper
 * around a domain shape, not the domain shape itself.
 *
 * ADR-0039 moved *request* bodies here and deliberately left responses as
 * "type what goes out", which was right about validation but left the
 * envelope declared twice: once as a route-local `type OneResponse` on the
 * server, once as an inline `request<{ ... }>` generic in the web client.
 * Neither referenced the other, so the compiler could not see that the two
 * were meant to be the same contract — the same gap ADR-0039 closed for
 * requests, where `LlmConfig`/`GetConfigResponse` had already silently
 * drifted on `api`. Issue #231 found three response envelopes that had
 * drifted the same way (see ADR-0040).
 *
 * The ADR-0039 rule is unchanged: **schema what crosses the wire inbound,
 * type what goes out.** These are plain types, not Zod schemas, on purpose —
 * the server produces them from the DB and the client never parses them from
 * untrusted input, so a runtime schema would be cost without benefit. What
 * they buy is a compile-time link between the two sides, which is why both
 * the route handler and the `request<...>` call site must name the type
 * rather than restate its shape.
 *
 * `LlmConfig` stays in `apiSchemas.ts` next to the custom-provider schemas it
 * is assembled from, rather than moving here — it was already shared, and
 * splitting it from `CustomProviderView` would trade one cross-file hop for
 * another with no compile-time gain.
 */

// ---- Common ----------------------------------------------------------------

/**
 * Acknowledgement of a mutation that returns nothing else.
 *
 * On the wire `ok` is always `true` — a failure leaves via `HTTPException`
 * and renders as the ADR-0039 error envelope instead, so there is no
 * `ok: false` response. The field exists because a bare `{}` is
 * indistinguishable from an empty body on the client, not as a status flag to
 * branch on.
 *
 * Typed `boolean` rather than the literal `true` on purpose: the narrower type
 * buys no safety (nothing reads `ok`, and an `ok: false` would be a server bug
 * the client could not act on anyway) while making every test double that
 * returns `{ ok: true }` a compile error unless it is written `as const`.
 * Forcing that churn across mocks is exactly the cost issue #231 set out to
 * remove.
 */
export type OkResponse = { ok: boolean };

/** {@link OkResponse} plus the id the mutation acted on. Used by the deletes
 * and `POST /sessions/:id/stop`, which are idempotent by design: the id comes
 * back whether or not a row was actually removed. */
export type OkIdResponse = { ok: boolean; id: string };

// ---- Repos -----------------------------------------------------------------

/** `GET /api/repos` */
export type ListReposResponse = { repos: Repo[] };

/** `GET /api/repos/:id`, `POST /api/repos`, `POST /api/repos/workspace`,
 * `POST /api/repos/:id/pull` */
export type RepoResponse = { repo: Repo };

/** `GET /api/repos/:id/stats` */
export type RepoStatsResponse = { stats: RepoStats };

/** `POST /api/repos/:id/sync` */
export type RepoSyncResponse = { status: RepoSyncStatus };

// ---- Sessions --------------------------------------------------------------

/** `GET /api/sessions?repoId=` */
export type ListSessionsResponse = { sessions: SessionView[] };

/**
 * `GET /api/sessions/:id`, `POST /api/sessions`, `POST
 * /api/sessions/orchestrator`.
 *
 * The two `POST`s always send `contextUsage: null` — a brand-new Session has
 * no turns to estimate from, and an orchestrator Session never gets context
 * reporting at all. They share this envelope rather than a narrower
 * `{ session }` one because the field is on the wire either way; issue #231
 * found the client typing those two routes as `{ session: SessionView }`
 * only, so the same server type was modelled two different ways within one
 * file.
 */
export type SessionResponse = {
	session: SessionView;
	/** ADR-0023's addendum — see `SessionManager.getContextUsageEstimate`'s
	 * doc comment. `null` for an orchestrator Session or one whose
	 * provider/model has fallen out of dilna's catalog. */
	contextUsage: ContextUsageEstimate | null;
	/** The most recent completed Agent turns' cache usage, oldest last (issue
	 * 271) — seeds the context card's cache-instability warning on page load,
	 * where the live `usage_update` stream has no history. Reads
	 * `usage_events`' per-turn cache columns (agent turns only — judge rows
	 * have their own prefix and would pollute the consecutive-turn signal);
	 * capped at the 5 most recent. Empty for a brand-new Session. */
	recentCacheTurns: SessionCacheTurn[];
};

/** One completed Agent turn's cache split, from its `usage_events` row. */
export type SessionCacheTurn = {
	readTokens: number;
	writeTokens: number;
};

/** `GET /api/sessions/:id/burn-timeline` — every `usage_events` row of the
 * Session, oldest first (issue #293).
 *
 * Freshness policy, documented here because it spans both sides: the client
 * fetches once when the context panel's burn tab mounts, then *refetches*
 * (rather than assembling the arriving turn client-side, so compaction
 * markers and context stamps come from the same single home as the seed) on
 * each turn-end reconciling `usage_update` the Session's SSE stream already
 * carries — the moment a new row has landed — and never polls. The
 * implementation is the web's `useSessionBurnTimeline` hook; the server
 * side is a stateless read in `sessions/burnTimeline.ts`. */
export type BurnTimelineResponse = { turns: SessionBurnTurn[] };

/** The trim metadata the web needs to render a truncation marker on a
 * persisted tool_call part (issue #273). Everything
 * {@link TrimmedToolOutput} carries except `original` — the persisted
 * row already holds the verbatim text, so re-sending it per trimmed
 * part would double the payload for exactly the huge outputs this
 * exists to manage. Computed server-side by the same walk the seed
 * path runs (`collectSeedTrims`), so the marker a reload shows is byte
 * -identical to what the model was seeded with. */
export type SeedTrimView = {
	hash: string;
	seeded: string;
	originalLines: number;
	originalChars: number;
	seededLines: number;
	reason: TrimReason;
};

/** `GET /api/sessions/:id/messages`
 *
 * `trims` maps tool-call id → the trim that applies to that part at the
 * re-seed boundary. Optional only so an older client tolerates a newer
 * server; the server always sends it (empty when nothing in the history
 * would be trimmed). */
export type SessionMessagesResponse = {
	messages: Message[];
	trims?: Record<string, SeedTrimView>;
};

/** `GET /api/sessions/:id/changed-files` */
export type ChangedFilesResponse = { files: ChangedFile[] };

// ---- Comparisons (issue #250, ADR-0047) -------------------------------------

/**
 * A Comparison as the UI reads it: the group id (also the `/compare/<id>`
 * route param), the Repo every arm shares, and the arms in creation order
 * (the order the columns render in). A grouping over Sessions, not an entity
 * of its own — see ADR-0047 for why there is no `comparisons` table and no
 * prompt field here (each arm's first user message *is* the prompt).
 */
export type ComparisonView = {
	id: string;
	repoId: string;
	createdAt: number;
	sessions: SessionView[];
};

/** `GET /api/comparisons/:id`, `POST /api/comparisons` */
export type ComparisonResponse = { comparison: ComparisonView };

/** `GET /api/sessions/:id/commits` */
export type CommitsResponse = { commits: CommitInfo[] };

/** `GET /api/sessions/:id/artefacts` */
export type ArtefactsResponse = { artefacts: Artefact[] };

/** `GET /api/sessions/:id/scores` — every score in the Session, oldest first. */
export type TurnScoresResponse = { scores: TurnScore[] };

/** `POST /api/sessions/:id/turns/:turnId/scores` — the score just judged. */
export type TurnScoreResponse = { score: TurnScore };

/** `POST /api/sessions/:id/messages` — 202, the turn is claimed but not done. */
export type SendMessageResponse = { ok: boolean; message: Message };

/** `POST /api/sessions/:id/attachments` */
export type AttachmentResponse = { attachment: Attachment };

/** `POST /api/sessions/:id/queue` — 202. */
export type QueueMessageResponse = { ok: boolean; entry: QueuedMessage };

/** `GET /api/sessions/:id/queue` */
export type ListQueuedResponse = { queued: QueuedMessage[] };

// ---- Usage -----------------------------------------------------------------

/** `GET /api/usage` */
export type UsageSummaryResponse = { summary: UsageSummary };

/** `GET /api/usage/disk` */
export type DiskUsageResponse = { disk: DiskUsage };

// ---- Skills ----------------------------------------------------------------

/** `GET /api/skills` */
export type ListSkillsResponse = { skills: Skill[] };

/** `GET /api/skills/repo/:repoId` */
export type ListRepoSkillsResponse = { skills: RepoSkill[] };

/** `GET /api/skills/search?q=` */
export type SearchSkillsResponse = { results: SkillSearchResult[] };

/** `POST /api/skills`. Whether the install replaced an existing skill is
 * carried by the status code (200 vs 201), not a body field — `request()`
 * discards the status, so the client cannot currently tell the two apart. */
export type InstallSkillResponse = { skill: Skill };

// ---- Config ----------------------------------------------------------------

/** `PUT /api/config` — echoes the override that is now in effect. */
export type SetOverrideResponse = {
	ok: boolean;
	override: { provider: string; model: string } | null;
};

/** `DELETE /api/config` — the override is always cleared, hence `null`. */
export type ClearOverrideResponse = { ok: boolean; override: null };

/** `PUT`/`DELETE /api/config/roles/:role` (issue #308) — echoes the role's
 * assignment now in effect (`null` after a clear). */
export type SetModelRoleResponse = {
	ok: boolean;
	role: ModelRole;
	assignment: ModelRoleAssignment | null;
};

/** `POST /api/config/providers/anthropic/oauth/start` */
export type OauthStartResponse = { loginId: string; authUrl: string };

// ---- Push ------------------------------------------------------------------

/**
 * `GET /api/push/key`.
 *
 * `subscriptions` and `lastSuccessAt` are delivery health, which the route's
 * doc comment calls the first thing to check when notifications aren't
 * arriving. Issue #231 found the client typing only
 * `{ publicKey, configured }`, so those two fields reached the browser on
 * every call but were invisible to every consumer.
 */
export type PushKeyResponse = {
	publicKey: string | null;
	configured: boolean;
	subscriptions: number;
	lastSuccessAt: number | null;
};

/** `POST /api/push/subscribe`, `POST /api/push/unsubscribe` */
export type PushSubscriptionsResponse = { ok: boolean; subscriptions: number };
