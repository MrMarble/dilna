PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_provider_credentials` (
	`provider` text PRIMARY KEY NOT NULL,
	`api_key` text,
	`oauth_access` text,
	`oauth_refresh` text,
	`oauth_expires_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_provider_credentials`("provider", "api_key", "updated_at") SELECT "provider", "api_key", "updated_at" FROM `provider_credentials`;--> statement-breakpoint
DROP TABLE `provider_credentials`;--> statement-breakpoint
ALTER TABLE `__new_provider_credentials` RENAME TO `provider_credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
