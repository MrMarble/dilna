CREATE TABLE `truncated_outputs` (
	`hash` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`path` text,
	`session_id` text NOT NULL,
	`original_chars` integer NOT NULL,
	`original_lines` integer NOT NULL,
	`created_at` integer NOT NULL
);
