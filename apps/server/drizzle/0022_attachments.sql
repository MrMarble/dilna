CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL
);
