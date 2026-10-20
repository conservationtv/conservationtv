CREATE TABLE `converge_spec` (
	`id` integer PRIMARY KEY,
	`spec` text NOT NULL,
	`saved_at` text NOT NULL,
	CONSTRAINT "converge_spec_single_row" CHECK("id" = 1)
);
