ALTER TABLE `ab_tests` ADD `pair_id` text;
--> statement-breakpoint
CREATE TABLE `tuning_progress` (
	`drone_id` integer NOT NULL,
	`step` text NOT NULL,
	`done` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	`notes` text,
	PRIMARY KEY(`drone_id`, `step`),
	FOREIGN KEY (`drone_id`) REFERENCES `drones`(`id`) ON UPDATE no action ON DELETE cascade
);
