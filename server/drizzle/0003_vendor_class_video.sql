ALTER TABLE `vendor_presets` ADD `vendor` text;--> statement-breakpoint
ALTER TABLE `vendor_presets` ADD `size_class` text;--> statement-breakpoint
ALTER TABLE `vendor_presets` ADD `video_system` text;--> statement-breakpoint
ALTER TABLE `vendor_presets` ADD `cells` text;--> statement-breakpoint
ALTER TABLE `vendor_presets` ADD `bf_version` text;--> statement-breakpoint
ALTER TABLE `vendor_presets` ADD `kind` text DEFAULT 'factory' NOT NULL;--> statement-breakpoint
ALTER TABLE `vendor_presets` ADD `variant` text;--> statement-breakpoint
ALTER TABLE `vendor_presets` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `drones` ADD `video_system` text;--> statement-breakpoint
ALTER TABLE `profiles` ADD `video_system` text;--> statement-breakpoint
ALTER TABLE `profiles` ADD `notes` text;
