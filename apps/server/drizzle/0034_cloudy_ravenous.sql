CREATE TABLE `truncation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`hash` text NOT NULL,
	`call_id` text,
	`tokens_saved` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `truncation_events_dedupe_idx` ON `truncation_events` (`session_id`,`call_id`,`kind`);--> statement-breakpoint
CREATE INDEX `truncation_events_session_idx` ON `truncation_events` (`session_id`);