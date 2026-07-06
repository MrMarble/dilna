CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`parts_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`path` text NOT NULL,
	`default_branch` text NOT NULL,
	`remote_url` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_slug_unique` ON `repos` (`slug`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`worktree_dir_name` text NOT NULL,
	`branch_name` text NOT NULL,
	`agent_type` text DEFAULT 'opencode' NOT NULL,
	`agent_session_id` text,
	`title` text DEFAULT 'New session' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL
);
