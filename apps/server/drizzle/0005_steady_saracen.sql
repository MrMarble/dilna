PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`worktree_dir_name` text NOT NULL,
	`branch_name` text NOT NULL,
	`agent_type` text DEFAULT 'pi' NOT NULL,
	`title` text DEFAULT 'New session' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "repo_id", "worktree_path", "worktree_dir_name", "branch_name", "agent_type", "title", "status", "input_tokens", "output_tokens", "created_at", "last_active_at") SELECT "id", "repo_id", "worktree_path", "worktree_dir_name", "branch_name", "agent_type", "title", "status", "input_tokens", "output_tokens", "created_at", "last_active_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;