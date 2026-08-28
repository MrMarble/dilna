import { relations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = () => Math.floor(Date.now() / 1000);

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
	title: text("title").notNull().default("New session"),
	status: text("status").notNull().default("idle"),
	/** Session-lifetime token totals, accumulated turn by turn (see
	 * SessionManager.accumulateSessionUsage — the SDK only reports per-turn
	 * usage, so dilna has to do its own bookkeeping for totals to survive
	 * idle-kill/resume and page reloads). */
	inputTokens: integer("input_tokens").notNull().default(0),
	outputTokens: integer("output_tokens").notNull().default(0),
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

export const sessionsRelations = relations(sessions, ({ many }) => ({
	messages: many(messages),
}));

export const reposRelations = relations(repos, ({ many }) => ({
	sessions: many(sessions),
}));
