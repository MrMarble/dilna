CREATE TABLE `llm_config` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text,
	`model` text,
	`updated_at` integer NOT NULL
);
