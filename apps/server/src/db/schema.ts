import { relations } from "drizzle-orm";
import {
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

const now = () => Math.floor(Date.now() / 1000);

/**
 * Instance-wide LLM provider/model override, set via the web Settings form
 * and served by the /api/config route (see providerConfigStore.ts for how it
 * combines with the env fallback). A single row (congruence key `id =
 * "instance"`); a null provider means "no override — fall back to
 * DILNA_PROVIDER/DILNA_MODEL env". Env stays the default/fallback; this
 * table is only consulted when the override row exists.
 */
export const llmConfig = sqliteTable("llm_config", {
	id: text("id").primaryKey(),
	provider: text("provider"),
	model: text("model"),
	updatedAt: integer("updated_at").notNull().$defaultFn(now),
});

export const repos = sqliteTable("repos", {
	id: text("id").primaryKey(),
	slug: text("slug").notNull().unique(),
	path: text("path").notNull(),
	defaultBranch: text("default_branch").notNull(),
	remoteUrl: text("remote_url").notNull(),
	createdAt: integer("created_at").notNull().$defaultFn(now),
});

export const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	repoId: text("repo_id").notNull(),
	worktreePath: text("worktree_path").notNull(),
	worktreeDirName: text("worktree_dir_name").notNull(),
	branchName: text("branch_name").notNull(),
	agentType: text("agent_type").notNull().default("pi"),
	/** "session" | "orchestrator" (packages/shared's SessionKind) — see
	 * ADR-0021. Every pre-existing row defaults to "session". */
	kind: text("kind").notNull().default("session"),
	title: text("title").notNull().default("New session"),
	status: text("status").notNull().default("idle"),
	/** Session-lifetime token totals, accumulated turn by turn (see
	 * SessionManager.accumulateSessionUsage — the SDK only reports per-turn
	 * usage, so dilna has to do its own bookkeeping for totals to survive
	 * idle-kill/resume and page reloads). */
	inputTokens: integer("input_tokens").notNull().default(0),
	outputTokens: integer("output_tokens").notNull().default(0),
	/** Compaction (ADR-0023): summary text standing in for every `messages`
	 * row up to and including `compactedThroughMessageId`, when the live
	 * agent is re-seeded. Null until the Session's first compaction. */
	compactedSummary: text("compacted_summary"),
	/** id of the last `messages` row folded into `compactedSummary`
	 * (inclusive) — an unenforced pointer (no FK), same tolerance as
	 * `usageEvents`' dangling ids. Raw `messages` rows are never deleted or
	 * rewritten by compaction; this only marks where a freshly-seeded
	 * `Agent`'s context should switch from the summary to verbatim history. */
	compactedThroughMessageId: text("compacted_through_message_id"),
	/** ADR-0025: the orchestrator Session's own id, when this Session was
	 * created via `dilna_create_session` — null for every Session created
	 * directly via the UI, or for an orchestrator Session itself. No FK
	 * (same dangling-id tolerance as `usageEvents`/`sessionArchive`). */
	spawnedBy: text("spawned_by"),
	/** The concrete provider/model this Session was created to run on, seen
	 * via the Settings view's "model for new sessions" selector (override ??
	 * env) and snapshotted at `create()` time (multi-provider support, ADR
	 * n/a; see providerCredentials.ts). Null for pre-migration rows and for
	 * Sessions created with no provider/model resolvable at create time
	 * (env not set etc.) — such Sessions lazily resolve the then-effective
	 * config on their first start instead (the same fallback pre-existing
	 * Sessions always used). */
	provider: text("provider"),
	model: text("model"),
	createdAt: integer("created_at").notNull().$defaultFn(now),
	lastActiveAt: integer("last_active_at").notNull().$defaultFn(now),
});

/**
 * One row per provider that has a **dilna-managed** credential — either an
 * API key or an OAuth login, added via the Settings view's "Add a provider"
 * / "Sign in with Claude" flows (providerCredentials.ts). This is a
 * per-provider extension layered *over* the env default: provider keys that
 * come from `process.env` (ANTHROPIC_API_KEY & co., ADR-0005 host
 * passthrough) are not stored here; when a stored credential exists it wins
 * over env (Settings takes precedence over env, matching how the
 * provider/model override already outranks DILNA_PROVIDER/DILNA_MODEL), and
 * for a provider with both a stored OAuth login and a stored API key, OAuth
 * wins (see providerCredentials.ts's `resolveApiKey`). Stored at rest in the
 * same SQLite db as every other dilna secret/config (llm_config, repo
 * memory), consistent with dilna being a self-hosted single-user app with no
 * auth layer — plaintext-keyed, not encrypted; see providerCredentials.ts's
 * module doc comment. The Settings UI masks the value and only ever re-sends
 * it to *set or replace*, never to display.
 *
 * `oauth*` columns are only ever populated for `anthropic` today — it's the
 * only dilna-allowlisted provider `pi-ai` ships an OAuth flow for. `apiKey`
 * became nullable when OAuth support was added: a row can now hold just an
 * OAuth login with no API key at all. */
export const providerCredentials = sqliteTable("provider_credentials", {
	provider: text("provider").primaryKey(),
	apiKey: text("api_key"),
	/** OAuth access token — a live `sk-ant-oat...` token when present. `pi-ai`'s
	 * anthropic-messages API layer auto-detects this prefix and switches to
	 * Bearer auth + the oauth beta headers itself; dilna never has to branch
	 * on credential type on the request path. */
	oauthAccess: text("oauth_access"),
	/** OAuth refresh token, used by `resolveApiKey` to rotate `oauthAccess`
	 * once it's within `OAUTH_MIN_VALIDITY_MS` of `oauthExpiresAt`. */
	oauthRefresh: text("oauth_refresh"),
	/** Epoch-ms expiry of `oauthAccess`, mirroring `OAuthCredential.expires`
	 * from `@earendil-works/pi-ai`'s auth types. */
	oauthExpiresAt: integer("oauth_expires_at"),
	updatedAt: integer("updated_at").notNull().$defaultFn(now),
});

/**
 * A user-defined LLM provider (Ollama, LM Studio, vLLM, or anything else
 * speaking one of the four API shapes `pi-ai` supports) — the same
 * capability pi's own CLI exposes via a hand-edited `~/.pi/agent/models.json`
 * (see docs/adr n/a; customProviders.ts's module doc comment for the full
 * design). `id` is a user-chosen slug (e.g. `"ollama"`), immutable after
 * creation, and doubles as the `provider` value everywhere a Session's
 * provider/model is recorded — including as the primary key row in
 * `provider_credentials` for this provider's stored API key, via the same
 * table/flow builtin providers already use.
 *
 * `modelsJson` follows the `messages.partsJson` convention: a plain JSON
 * array (`CustomModelDef[]` from customProviders.ts), parsed at the call
 * site rather than via drizzle's json column mode. */
export const customProviders = sqliteTable("custom_providers", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	baseUrl: text("base_url").notNull(),
	/** One of `CUSTOM_PROVIDER_APIS` (providerConfig.ts) — the `pi-ai` `Api`
	 * every model on this provider is built with. */
	api: text("api").notNull(),
	modelsJson: text("models_json").notNull(),
	createdAt: integer("created_at").notNull().$defaultFn(now),
	updatedAt: integer("updated_at").notNull().$defaultFn(now),
});

export const messages = sqliteTable("messages", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").notNull(),
	role: text("role").notNull(),
	partsJson: text("parts_json").notNull(),
	/** Groups the rows one user turn produced (ADR-0026 §3 persists one row
	 * per pi-agent-core round, so a tool-heavy turn is several rows). Null for
	 * user rows, boot-time `"system"` notices, and pre-migration rows —
	 * consumers treat null as "never grouped". See
	 * `packages/shared`'s `Message.turnId`. */
	turnId: text("turn_id"),
	createdAt: integer("created_at").notNull().$defaultFn(now),
});

/**
 * Per-Repo agent-curated memory (issue #59): short, durable facts an agent
 * discovers about a Repo (e.g. "tests need FOO_ENV set") that should survive
 * across otherwise-isolated Sessions/Worktrees (ADR-0010). One row per repo,
 * upserted wholesale by `repos/memory.ts` — never partially patched — and
 * bounded to REPO_MEMORY_MAX_CHARS there, not in the schema, so the limit
 * stays a single source of truth alongside the write path.
 */
export const repoMemory = sqliteTable("repo_memory", {
	repoId: text("repo_id").primaryKey(),
	content: text("content").notNull().default(""),
	updatedAt: integer("updated_at").notNull().$defaultFn(now),
});

/**
 * A globally-installed agent skill (issue #60): one row per skill, keyed by
 * the registry-stable `{source}/{slug}` id (e.g. `mattpocock/skills/tdd`).
 *
 * Install is **global, enablement is per-Repo** — there is exactly one copy
 * of a skill's files on disk (`<data>/skills/<id>/`, see repos/skills.ts),
 * and `repo_skills` below records which Repos it's turned on for. That's why
 * this table has no `repoId`: installing the same skill for a second Repo
 * must not duplicate the download.
 *
 * `name`/`description` are denormalized out of the skill's SKILL.md
 * frontmatter at install time so the management list can render without
 * re-reading (and re-parsing) every skill folder off disk on each request.
 * The files on disk stay the source of truth for skill *content*; these two
 * columns are a cache of its metadata, refreshed on reinstall.
 */
export const skills = sqliteTable("skills", {
	/** `{source}/{slug}`, matching skills.sh's stable id — also the on-disk
	 * directory name under `<data>/skills/`. */
	id: text("id").primaryKey(),
	/** Owner/repo the skill came from (`mattpocock/skills`), or the pasted
	 * URL's equivalent. Blank for a skill installed from a raw upload. */
	source: text("source").notNull(),
	/** Skill folder name / registry slug (`tdd`). */
	slug: text("slug").notNull(),
	/** `name` from SKILL.md frontmatter (required by the spec). */
	name: text("name").notNull(),
	/** `description` from SKILL.md frontmatter — what the model matches on to
	 * decide a skill is relevant, so it's shown verbatim in the UI. */
	description: text("description").notNull().default(""),
	/** Where the files came from, for re-install/update and UI attribution:
	 * the GitHub repo URL, or the user-pasted URL. */
	sourceUrl: text("source_url").notNull().default(""),
	installedAt: integer("installed_at").notNull().$defaultFn(now),
	updatedAt: integer("updated_at").notNull().$defaultFn(now),
});

/**
 * Which Repos a globally-installed skill is enabled for (issue #60). Presence
 * of a row means enabled; disabling deletes the row rather than flipping a
 * flag, so "enabled" needs no default-value reasoning for Repos that existed
 * before a skill was installed — a skill is off everywhere until explicitly
 * turned on, which is also the safer default for third-party content landing
 * in an Agent's context.
 *
 * Composite primary key (`skillId`, `repoId`) makes the enable path an
 * idempotent upsert. No FKs, matching the rest of this schema; both sides are
 * cleaned up explicitly (skill uninstall, and `RepoManager.delete`).
 */
export const repoSkills = sqliteTable(
	"repo_skills",
	{
		skillId: text("skill_id").notNull(),
		repoId: text("repo_id").notNull(),
		enabledAt: integer("enabled_at").notNull().$defaultFn(now),
	},
	(t) => [primaryKey({ columns: [t.skillId, t.repoId] })],
);

/**
 * Last-known account-wide plan rate-limit reading per window (one row per
 * `RateLimitWindowKind`), persisted so the sidebar footer survives a server
 * restart / page reload without waiting for the next agent turn to re-fetch
 * from the SDK. Staleness is still computed at read time (see
 * sessions/rateLimits.ts) — rows whose `resetsAt` has passed are simply
 * filtered out, never eagerly deleted.
 */
export const rateLimits = sqliteTable("rate_limits", {
	kind: text("kind").primaryKey(),
	utilizationPct: integer("utilization_pct").notNull(),
	resetsAt: integer("resets_at").notNull(),
	updatedAt: integer("updated_at").notNull().$defaultFn(now),
});

/**
 * One row per turn (not per internal assistant round — see
 * `SessionManager.accumulateSessionUsage`'s `agent_end`-sourced
 * `cumulative` usage), for the dashboard's time-series/cost breakdown
 * (`sessions/usageStats.ts`). Deliberately outlives its `sessionId`/`repoId`:
 * `sessions.delete` hard-deletes `messages` but must not erase historical
 * spend, so there's no FK/cascade here — a dangling id after a session or
 * repo is removed just renders as "unknown" client-side.
 */
export const usageEvents = sqliteTable("usage_events", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").notNull(),
	repoId: text("repo_id").notNull(),
	provider: text("provider").notNull(),
	model: text("model").notNull(),
	inputTokens: integer("input_tokens").notNull().default(0),
	outputTokens: integer("output_tokens").notNull().default(0),
	cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
	cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
	reasoningTokens: integer("reasoning_tokens").notNull().default(0),
	costUsd: real("cost_usd").notNull().default(0),
	createdAt: integer("created_at").notNull().$defaultFn(now),
});

/**
 * A deleted ordinary Session's final summary (ADR-0024), written by
 * `SessionManager.delete` just before it hard-deletes the Session's own
 * `messages`/`sessions` rows — this is what survives that deletion, readable
 * later via the orchestrator's `dilna_list_archived_sessions`/
 * `dilna_get_archived_session` tools (`sessions/archive.ts`). `sessionId` is
 * its own primary key (a Session is archived at most once); no FK to
 * `sessions`/`repos` — deliberately outlives both, same as `usage_events`
 * above.
 */
export const sessionArchive = sqliteTable("session_archive", {
	sessionId: text("session_id").primaryKey(),
	repoId: text("repo_id").notNull(),
	title: text("title").notNull(),
	summary: text("summary").notNull(),
	createdAt: integer("created_at").notNull(),
	archivedAt: integer("archived_at").notNull().$defaultFn(now),
});

/**
 * The instance's VAPID keypair for Web Push (ADR-0029) — a single row
 * (congruence key `id = "instance"`), generated on first boot when absent and
 * never rotated thereafter.
 *
 * Rotation is what makes this a *table* rather than an env var: VAPID keys
 * identify the application server to the push service, and every stored
 * subscription in `push_subscriptions` is bound to the key that created it.
 * Regenerating the pair silently invalidates all of them, so the value has to
 * survive restarts and redeploys without the operator having to manage it.
 *
 * Stored plaintext, consistent with `provider_credentials` above — dilna is a
 * self-hosted single-user app with no auth layer. Unlike a provider API key,
 * this secret grants nothing beyond signing pushes to this instance's own
 * subscribers.
 *
 * Both keys are base64url, matching the wire format the Web Push APIs use:
 * `publicKey` is the uncompressed P-256 point handed to `pushManager.subscribe`
 * as `applicationServerKey`, `privateKey` its PKCS#8 encoding.
 */
export const pushVapidKeys = sqliteTable("push_vapid_keys", {
	id: text("id").primaryKey(),
	publicKey: text("public_key").notNull(),
	privateKey: text("private_key").notNull(),
	createdAt: integer("created_at").notNull().$defaultFn(now),
});

/**
 * A browser's Web Push subscription (ADR-0029). Instance-global: dilna has no
 * `userId` anywhere in the schema and authenticates with one shared bearer
 * token, so there is no owner to scope these to — every registered browser
 * receives every turn-completion notification.
 *
 * Keyed by `endpoint` because that *is* the push service's identifier for the
 * subscription; re-subscribing the same browser yields the same endpoint, so
 * an upsert naturally de-duplicates rather than accumulating rows.
 *
 * `p256dh` and `auth` are the subscription's own public key and shared secret
 * (base64url), used to encrypt each payload per RFC 8291 — without them a
 * push can only be sent empty. They are not dilna secrets: they are generated
 * by the subscribing browser and are useless without the instance's VAPID
 * private key.
 *
 * `lastSuccessAt` is diagnostic: set whenever a push service accepts a
 * delivery, and served by `/api/push/key` as the only externally visible
 * evidence that push works end to end (a row here proves a browser
 * *registered*, not that anything was delivered). It records acceptance by
 * the service, not display on the handset — Web Push has no delivery
 * receipt. Nothing prunes by age; dead subscriptions are removed eagerly
 * when the push service reports 404/410 (see pushSender.ts).
 */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
	endpoint: text("endpoint").primaryKey(),
	p256dh: text("p256dh").notNull(),
	auth: text("auth").notNull(),
	createdAt: integer("created_at").notNull().$defaultFn(now),
	lastSuccessAt: integer("last_success_at"),
});

export const sessionsRelations = relations(sessions, ({ many }) => ({
	messages: many(messages),
}));

export const reposRelations = relations(repos, ({ many }) => ({
	sessions: many(sessions),
}));
