CREATE TABLE `repo_skills` (
	`skill_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`enabled_at` integer NOT NULL,
	PRIMARY KEY(`skill_id`, `repo_id`)
);
