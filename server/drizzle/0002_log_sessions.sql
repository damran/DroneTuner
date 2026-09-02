ALTER TABLE `logs` ADD `session_index` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `logs` ADD `session_count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `logs` ADD `original_name` text;--> statement-breakpoint
ALTER TABLE `logs` ADD `duration_s` integer;--> statement-breakpoint
ALTER TABLE `logs` ADD `recorded_at` integer;
