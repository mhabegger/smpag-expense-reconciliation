DROP INDEX `import_batches_file_hash_uq`;--> statement-breakpoint
CREATE INDEX `import_batches_file_hash_idx` ON `import_batches` (`file_hash`);--> statement-breakpoint
CREATE INDEX `transactions_merchant_norm_idx` ON `transactions` (`merchant_norm`);