CREATE TABLE `merchant_notes` (
	`merchant_norm` text PRIMARY KEY NOT NULL,
	`note` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `transactions` ADD `note` text;