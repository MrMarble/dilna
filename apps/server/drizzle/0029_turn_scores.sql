CREATE TABLE `turn_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`metric` text NOT NULL,
	`criteria` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`score` real NOT NULL,
	`threshold` real NOT NULL,
	`passed` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turn_scores_session_idx` ON `turn_scores` (`session_id`);--> statement-breakpoint
ALTER TABLE `usage_events` ADD `purpose` text DEFAULT 'turn' NOT NULL;
