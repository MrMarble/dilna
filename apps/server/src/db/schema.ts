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
	agentType: text("agent_type").notNull().default("claude"),
	agentSessionId: text("agent_session_id"),
	title: text("title").notNull().default("New session"),
	status: text("status").notNull().default("idle"),
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

export const sessionsRelations = relations(sessions, ({ many }) => ({
	messages: many(messages),
}));

export const reposRelations = relations(repos, ({ many }) => ({
	sessions: many(sessions),
}));
