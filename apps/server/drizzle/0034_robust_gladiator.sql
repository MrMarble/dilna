CREATE TABLE `truncation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`hash` text NOT NULL,
	`session_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `truncation_events_session_idx` ON `truncation_events` (`session_id`);