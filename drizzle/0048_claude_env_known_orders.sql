-- IPRoyal orders bought outside the automatic flow (2026-10-26). The cron
-- reconciliation lists every ISP order on the IPRoyal account and alerts the
-- owner once for any order that is neither a subscription's iproyal_order_id
-- nor registered here, so no purchase can go unnoticed again.
CREATE TABLE `claude_env_known_orders` (
	`order_id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `claude_env_known_orders` (`order_id`, `label`, `created_at`) VALUES
	('75930342', '老板自用 161.77.8.204', 1793016000000),
	('86547609', '客户 GM1E7EC2 161.77.217.39（手动 provision.py）', 1793016000000);
