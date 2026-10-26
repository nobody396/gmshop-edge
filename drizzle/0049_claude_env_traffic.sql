-- Claude 专属环境 traffic add-ons, usage notices and upstream capacity (2026-10-26).
-- A paid add-on raises the entitlement of the subscription's CURRENT 30-day
-- traffic period only: entitlement = traffic_quota_bytes (base 200 GB) + the
-- applied add-ons whose period_start equals the current period start, so a new
-- period falls back to the base without any reset job.
CREATE TABLE `claude_env_traffic_addons` (
	`order_item_id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`subscription_id` text REFERENCES `claude_env_subscriptions`(`id`),
	`status` text NOT NULL,
	`gb` integer NOT NULL,
	`units` integer DEFAULT 1 NOT NULL,
	`bytes` integer NOT NULL,
	`period_start` integer,
	`delivered` integer DEFAULT 0 NOT NULL,
	`refund_handled` integer DEFAULT 0 NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "claude_env_traffic_addons_status_check" CHECK("claude_env_traffic_addons"."status" IN ('applied','waiting','skipped','refunded')),
	CONSTRAINT "claude_env_traffic_addons_bytes_check" CHECK("claude_env_traffic_addons"."bytes" > 0 AND "claude_env_traffic_addons"."units" > 0)
);
--> statement-breakpoint
CREATE INDEX `claude_env_traffic_addons_period_idx` ON `claude_env_traffic_addons` (`subscription_id`,`period_start`,`status`);
--> statement-breakpoint
CREATE INDEX `claude_env_traffic_addons_status_idx` ON `claude_env_traffic_addons` (`status`,`delivered`);
--> statement-breakpoint
-- Upstream (IPRoyal) traffic purchases reported by the buyer CLI; `ref` is the
-- CLI's idempotency key. period_start is the subscription's traffic period
-- that contained `purchased_at`.
CREATE TABLE `claude_env_upstream_purchases` (
	`ref` text PRIMARY KEY NOT NULL,
	`iproyal_order_id` text NOT NULL,
	`subscription_id` text REFERENCES `claude_env_subscriptions`(`id`),
	`period_start` integer,
	`gb` integer NOT NULL,
	`bytes` integer NOT NULL,
	`cost_usd_cents` integer,
	`purchased_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "claude_env_upstream_purchases_bytes_check" CHECK("claude_env_upstream_purchases"."bytes" > 0)
);
--> statement-breakpoint
CREATE INDEX `claude_env_upstream_purchases_period_idx` ON `claude_env_upstream_purchases` (`subscription_id`,`period_start`);
--> statement-breakpoint
-- One row per (subscription, period, kind): customer usage notices p7500 /
-- p9000 / p9750 and the owner safety net `owner_unbought`. Applying an add-on
-- deletes the customer rows the new entitlement is no longer above, so only a
-- real new crossing is notified again.
CREATE TABLE `claude_env_traffic_notices` (
	`subscription_id` text NOT NULL REFERENCES `claude_env_subscriptions`(`id`),
	`period_start` integer NOT NULL,
	`kind` text NOT NULL,
	`entitled_bytes` integer NOT NULL,
	`used_bytes` integer NOT NULL,
	`status` text DEFAULT 'sending' NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`subscription_id`, `period_start`, `kind`),
	CONSTRAINT "claude_env_traffic_notices_kind_check" CHECK("claude_env_traffic_notices"."kind" IN ('p7500','p9000','p9750','owner_unbought')),
	CONSTRAINT "claude_env_traffic_notices_status_check" CHECK("claude_env_traffic_notices"."status" IN ('sending','sent','skipped','failed','superseded'))
);
--> statement-breakpoint
-- Latest upstream usage reading reported by the buyer CLI.
ALTER TABLE `claude_env_subscriptions` ADD `upstream_used_bytes` integer;
--> statement-breakpoint
ALTER TABLE `claude_env_subscriptions` ADD `upstream_used_at` integer;
