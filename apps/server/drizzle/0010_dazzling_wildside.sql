CREATE TABLE `session_archive` (
	`session_id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer NOT NULL
);
