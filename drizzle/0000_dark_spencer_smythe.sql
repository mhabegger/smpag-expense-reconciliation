CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`institute` text NOT NULL,
	`label` text NOT NULL,
	`company_id` text,
	`default_currency` text DEFAULT 'CHF' NOT NULL,
	`iban` text,
	`card_last4` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounts_kind_idx` ON `accounts` (`kind`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`config` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `classification_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern` text NOT NULL,
	`is_regex` integer DEFAULT false NOT NULL,
	`classification` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `column_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`institute` text NOT NULL,
	`source_type` text NOT NULL,
	`ledger` text NOT NULL,
	`builtin_key` text,
	`header_signature` text,
	`field_map` text NOT NULL,
	`options` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `column_mappings_institute_idx` ON `column_mappings` (`institute`,`source_type`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`classification` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_slug_uq` ON `companies` (`slug`);--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`base` text NOT NULL,
	`quote` text NOT NULL,
	`rate` real NOT NULL,
	`source` text DEFAULT 'frankfurter' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fx_rates_uq` ON `fx_rates` (`date`,`base`,`quote`,`source`);--> statement-breakpoint
CREATE INDEX `fx_rates_lookup_idx` ON `fx_rates` (`base`,`quote`,`date`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`source_type` text NOT NULL,
	`ledger` text NOT NULL,
	`file_name` text NOT NULL,
	`file_hash` text NOT NULL,
	`file_size` integer NOT NULL,
	`mapping_id` text,
	`status` text DEFAULT 'committed' NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`inserted_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`detected_encoding` text,
	`detected_delimiter` text,
	`period_start` text,
	`period_end` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mapping_id`) REFERENCES `column_mappings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_batches_file_hash_uq` ON `import_batches` (`file_hash`);--> statement-breakpoint
CREATE INDEX `import_batches_account_idx` ON `import_batches` (`account_id`);--> statement-breakpoint
CREATE TABLE `match_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`anchor_tx_id` text NOT NULL,
	`candidate_tx_id` text,
	`group_member_ids` text,
	`match_type` text NOT NULL,
	`score` integer NOT NULL,
	`score_breakdown` text NOT NULL,
	`converted_amount` integer,
	`fx_rate_used` real,
	`reason` text,
	`status` text DEFAULT 'suggested' NOT NULL,
	`run_id` text NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`anchor_tx_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_tx_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `match_candidates_anchor_idx` ON `match_candidates` (`anchor_tx_id`,`match_type`,`score`);--> statement-breakpoint
CREATE TABLE `match_group_members` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`tx_id` text NOT NULL,
	`contributed_amount` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `match_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tx_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_group_members_uq` ON `match_group_members` (`group_id`,`tx_id`);--> statement-breakpoint
CREATE INDEX `match_group_members_tx_idx` ON `match_group_members` (`tx_id`);--> statement-breakpoint
CREATE TABLE `match_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`anchor_tx_id` text NOT NULL,
	`match_type` text NOT NULL,
	`matched_amount` integer NOT NULL,
	`currency` text NOT NULL,
	`confidence` integer DEFAULT 0 NOT NULL,
	`note` text,
	`confirmed_by` text DEFAULT 'user' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`anchor_tx_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `match_groups_anchor_idx` ON `match_groups` (`anchor_tx_id`,`match_type`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`import_batch_id` text NOT NULL,
	`account_id` text NOT NULL,
	`ledger` text NOT NULL,
	`tx_date` text NOT NULL,
	`booking_date` text,
	`value_date` text,
	`direction` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'CHF' NOT NULL,
	`original_amount` integer,
	`original_currency` text,
	`fx_rate` real,
	`chf_equiv` integer,
	`merchant` text,
	`merchant_norm` text,
	`description` text,
	`reference` text,
	`counterparty` text,
	`category` text,
	`status_text` text,
	`classification` text DEFAULT 'unclassified' NOT NULL,
	`classified_at` integer,
	`classification_source` text,
	`recon_status` text DEFAULT 'open' NOT NULL,
	`accounting_linked` integer DEFAULT false NOT NULL,
	`bank_linked` integer DEFAULT false NOT NULL,
	`row_hash` text NOT NULL,
	`raw_payload` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_row_hash_uq` ON `transactions` (`row_hash`);--> statement-breakpoint
CREATE INDEX `transactions_ledger_date_idx` ON `transactions` (`ledger`,`tx_date`);--> statement-breakpoint
CREATE INDEX `transactions_chf_idx` ON `transactions` (`chf_equiv`,`currency`);--> statement-breakpoint
CREATE INDEX `transactions_class_idx` ON `transactions` (`classification`);--> statement-breakpoint
CREATE INDEX `transactions_recon_idx` ON `transactions` (`recon_status`);--> statement-breakpoint
CREATE INDEX `transactions_account_idx` ON `transactions` (`account_id`);