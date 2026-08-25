CREATE TABLE `components` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category` text NOT NULL,
	`name` text NOT NULL,
	`specs_json` text DEFAULT '{}' NOT NULL,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `drones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`size_class` text DEFAULT '' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drone_components` (
	`drone_id` integer NOT NULL,
	`component_id` integer NOT NULL,
	`slot` text NOT NULL,
	PRIMARY KEY (`drone_id`, `slot`),
	FOREIGN KEY (`drone_id`) REFERENCES `drones`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `drone_photos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drone_id` integer NOT NULL,
	`path` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`drone_id`) REFERENCES `drones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drone_id` integer NOT NULL,
	`file_path` text NOT NULL,
	`headers_json` text,
	`uploaded_at` integer NOT NULL,
	FOREIGN KEY (`drone_id`) REFERENCES `drones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `flights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drone_id` integer NOT NULL,
	`battery_component_id` integer,
	`log_id` integer,
	`date` integer NOT NULL,
	`duration_s` integer,
	`style_tag` text,
	FOREIGN KEY (`drone_id`) REFERENCES `drones`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`battery_component_id`) REFERENCES `components`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`log_id`) REFERENCES `logs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`log_id` integer NOT NULL,
	`metrics_json` text NOT NULL,
	`findings_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`log_id`) REFERENCES `logs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drone_id` integer,
	`name` text NOT NULL,
	`goal` text NOT NULL,
	`size_class` text,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`source` text DEFAULT 'template' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`drone_id`) REFERENCES `drones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fc_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drone_id` integer NOT NULL,
	`dump_json` text NOT NULL,
	`taken_at` integer NOT NULL,
	`reason` text,
	FOREIGN KEY (`drone_id`) REFERENCES `drones`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drone_id` integer,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`drone_id`) REFERENCES `drones`(`id`) ON UPDATE no action ON DELETE set null
);
