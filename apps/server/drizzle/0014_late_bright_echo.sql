CREATE TABLE `provider_credentials` (
	`provider` text PRIMARY KEY NOT NULL,
	`api_key` text NOT NULL,
	`updated_at` integer NOT NULL
);
