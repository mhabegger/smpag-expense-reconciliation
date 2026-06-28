ALTER TABLE `transactions` ADD `no_accounting_match` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `no_bank_match` integer DEFAULT false NOT NULL;