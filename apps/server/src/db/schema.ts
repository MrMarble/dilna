import { relations } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
	createdAt: integer("created_at").notNull().$defaultFn(now),
	lastActiveAt: integer("last_active_at").notNull().$defaultFn(now),
});

export const messages = sqliteTable("messages", {
	id: text("id").primaryKey(),
	sessionId: text("session_id").notNull(),
	role: text("role").notNull(),
	partsJson: text("parts_json").notNull(),
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

export const sessionsRelations = relations(sessions, ({ many }) => ({
	messages: many(messages),
}));

export const reposRelations = relations(repos, ({ many }) => ({
	sessions: many(sessions),
}));
