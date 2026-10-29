CREATE TABLE `log_record` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`recorded_at` integer NOT NULL,
	`level` text NOT NULL,
	`category` text NOT NULL,
	`message` text NOT NULL,
	`template` text NOT NULL,
	`properties` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `metric_point` (
	`series_id` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`value` real NOT NULL,
	CONSTRAINT `metric_point_pk` PRIMARY KEY(`series_id`, `observed_at`),
	CONSTRAINT `fk_metric_point_series_id_metric_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `metric_series`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `metric_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`key` text NOT NULL UNIQUE,
	`subject_id` text,
	`name` text NOT NULL,
	`unit` text NOT NULL,
	`dimensions` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `log_record_recorded_at` ON `log_record` (`recorded_at`);--> statement-breakpoint
CREATE INDEX `metric_point_observed_at` ON `metric_point` (`observed_at`);