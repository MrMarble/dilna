CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
