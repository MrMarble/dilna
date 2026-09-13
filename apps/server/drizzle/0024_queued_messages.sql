CREATE TABLE `queued_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`text` text NOT NULL,
	`attachments_json` text NOT NULL,
	`created_at` integer NOT NULL
);
