CREATE TABLE `ab_tests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drone_id` integer NOT NULL,
	`kind` text DEFAULT 'pid' NOT NULL,
	`created_at` integer NOT NULL,
	`variants_json` text DEFAULT '[]' NOT NULL,
	`notes` text,
	FOREIGN KEY (`drone_id`) REFERENCES `drones`(`id`) ON UPDATE no action ON DELETE cascade
);
