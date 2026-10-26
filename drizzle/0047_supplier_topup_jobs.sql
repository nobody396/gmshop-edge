-- Upstream wallet top-ups driven from the low-balance Telegram alert
-- (2026-10-26). A `create` row is one top-up: the owner picked an amount, the
-- Mac runner places the order and posts the payment QR. Each "充值完成" tap
-- adds a `collect` row that verifies payment, redeems/records and reads the
-- balance. `action_key` makes one button tap queue at most one job.
CREATE TABLE `supplier_topup_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`topup_id` text NOT NULL,
	`step` text NOT NULL,
	`supplier_id` text NOT NULL,
	`supplier_name` text NOT NULL,
	`amount_cny` integer NOT NULL,
	`status` text NOT NULL,
	`action_key` text NOT NULL,
	`order_json` text,
	`result` text,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_topup_jobs_action_key` ON `supplier_topup_jobs` (`action_key`);
--> statement-breakpoint
CREATE INDEX `supplier_topup_jobs_status` ON `supplier_topup_jobs` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX `supplier_topup_jobs_supplier` ON `supplier_topup_jobs` (`supplier_id`, `step`, `status`);
