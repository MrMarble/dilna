import type { Artefact } from "./artefact";
import type { ChangedFile } from "./diff";
import type { ContextUsageEstimate } from "./events";
import type { Attachment, Message, QueuedMessage } from "./messages";
import type { CommitInfo, Repo, RepoStats, RepoSyncStatus } from "./repo";
import type { TurnScore } from "./scoring";
import type { SessionView } from "./session";
import type { RepoSkill, Skill, SkillSearchResult } from "./skill";
import type { DiskUsage, UsageSummary } from "./usage";

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

/** `GET /api/repos/:id`, `POST /api/repos`, `POST /api/repos/:id/pull` */
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
};

/** `GET /api/sessions/:id/messages` */
export type SessionMessagesResponse = { messages: Message[] };

/** `GET /api/sessions/:id/changed-files` */
export type ChangedFilesResponse = { files: ChangedFile[] };

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
