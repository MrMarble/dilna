CREATE TABLE `rate_limits` (
	`kind` text PRIMARY KEY NOT NULL,
	`utilization_pct` integer NOT NULL,
	`resets_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
