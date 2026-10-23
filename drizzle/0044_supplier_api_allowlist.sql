-- Only explicitly allowed accounts may hold supplier-API keys and buy at the
-- agent supply price (2026-10-23). Accounts that hold an unrevoked key when
-- this runs keep working; everyone else must be allowed by an administrator.
CREATE TABLE `supplier_api_allowed_users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`granted_by` text,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `supplier_api_allowed_users` (`user_id`, `granted_by`, `note`)
SELECT DISTINCT `user_id`, NULL, 'backfill: active key at allowlist migration'
FROM `supplier_api_keys` WHERE `revoked_at` IS NULL;
