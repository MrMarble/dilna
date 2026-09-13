CREATE TABLE `artefacts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`title` text NOT NULL,
	`filename` text NOT NULL,
	`source_path` text NOT NULL,
	`kind` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL
);
