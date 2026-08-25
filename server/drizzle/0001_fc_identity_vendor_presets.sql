ALTER TABLE `drones` ADD `fc_target` text;--> statement-breakpoint
ALTER TABLE `drones` ADD `fc_board` text;--> statement-breakpoint
ALTER TABLE `drones` ADD `fc_craft_name` text;--> statement-breakpoint
ALTER TABLE `drones` ADD `fc_uid` text;--> statement-breakpoint
CREATE TABLE `vendor_presets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`board_target` text,
	`component_id` integer,
	`drone_model` text,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`cli_dump` text,
	`source_url` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON UPDATE no action ON DELETE set null
);
