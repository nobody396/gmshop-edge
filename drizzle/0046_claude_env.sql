-- Claude 稳定使用环境 (hosted dedicated US IP) control center, 2026-10-24.
-- Relays pull their desired customer list and report results through HMAC-signed
-- requests; the whole flow stays idle until system setting
-- `claude_env.automation_enabled` is true.
CREATE TABLE `claude_env_relays` (
	`id` text PRIMARY KEY NOT NULL,
	`hostname` text NOT NULL,
	`secret_encrypted` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`max_customers` integer DEFAULT 10 NOT NULL,
	`monthly_quota_bytes` integer DEFAULT 5000000000000 NOT NULL,
	`host_month` text,
	`host_rx_bytes` integer DEFAULT 0 NOT NULL,
	`host_tx_bytes` integer DEFAULT 0 NOT NULL,
	`quota_alert_month` text,
	`last_report_at` integer,
	`offline_alerted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "claude_env_relays_status_check" CHECK("claude_env_relays"."status" IN ('active','disabled')),
	CONSTRAINT "claude_env_relays_capacity_check" CHECK("claude_env_relays"."max_customers" >= 0 AND "claude_env_relays"."monthly_quota_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE `claude_env_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`),
	`email` text NOT NULL,
	`order_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`plan` text NOT NULL,
	`status` text DEFAULT 'awaiting_ip' NOT NULL,
	`status_before_suspend` text,
	`relay_id` text REFERENCES `claude_env_relays`(`id`),
	`relay_port` integer,
	`relay_user` text,
	`relay_pass_encrypted` text,
	`iproyal_plan_id` integer NOT NULL,
	`iproyal_order_state` text,
	`iproyal_order_id` text,
	`iproyal_location` text,
	`ip` text,
	`ip_port` integer,
	`ip_city` text,
	`ip_tz` text,
	`ip_user_encrypted` text,
	`ip_pass_encrypted` text,
	`pending_days` integer DEFAULT 0 NOT NULL,
	`activated_at` integer,
	`expires_at` integer,
	`traffic_period_start` integer,
	`traffic_period_bytes` integer DEFAULT 0 NOT NULL,
	`traffic_total_bytes` integer DEFAULT 0 NOT NULL,
	`traffic_quota_bytes` integer DEFAULT 200000000000 NOT NULL,
	`relay_check_ok` integer DEFAULT 0 NOT NULL,
	`relay_check_fail_streak` integer DEFAULT 0 NOT NULL,
	`last_check_at` integer,
	`last_exit_ok` integer,
	`last_exit_ip` text,
	`last_anthropic_status` integer,
	`last_apply_error` text,
	`exit_fail_streak` integer DEFAULT 0 NOT NULL,
	`patrol_alerted` integer DEFAULT 0 NOT NULL,
	`qc_trust_score` real,
	`qc_scam_score` integer,
	`qc_note` text,
	`qc_at` integer,
	`needs_replace_reason` text,
	`refund_seen` integer DEFAULT 0 NOT NULL,
	`attempt_after` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "claude_env_subscriptions_plan_check" CHECK("claude_env_subscriptions"."plan" IN ('monthly','quarterly','eb_monthly','eb_quarterly')),
	CONSTRAINT "claude_env_subscriptions_status_check" CHECK("claude_env_subscriptions"."status" IN ('awaiting_ip','provisioning','active','needs_replace','grace','expired','suspended','cancelled')),
	CONSTRAINT "claude_env_subscriptions_order_state_check" CHECK("claude_env_subscriptions"."iproyal_order_state" IS NULL OR "claude_env_subscriptions"."iproyal_order_state" IN ('posting','ordered','unknown')),
	CONSTRAINT "claude_env_subscriptions_port_check" CHECK("claude_env_subscriptions"."relay_port" IS NULL OR "claude_env_subscriptions"."relay_port" BETWEEN 20000 AND 20999)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_env_subscriptions_order_item_uidx` ON `claude_env_subscriptions` (`order_item_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `claude_env_subscriptions_relay_port_uidx` ON `claude_env_subscriptions` (`relay_id`,`relay_port`);
--> statement-breakpoint
CREATE INDEX `claude_env_subscriptions_status_idx` ON `claude_env_subscriptions` (`status`,`attempt_after`);
--> statement-breakpoint
CREATE INDEX `claude_env_subscriptions_user_idx` ON `claude_env_subscriptions` (`user_id`,`status`);
--> statement-breakpoint
CREATE TABLE `claude_env_periods` (
	`order_item_id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`subscription_id` text REFERENCES `claude_env_subscriptions`(`id`),
	`kind` text NOT NULL,
	`plan` text,
	`days` integer DEFAULT 0 NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	`iproyal_plan_id` integer,
	`units_extended` integer DEFAULT 0 NOT NULL,
	`extend_status` text DEFAULT 'none' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "claude_env_periods_kind_check" CHECK("claude_env_periods"."kind" IN ('initial','renewal','skipped')),
	CONSTRAINT "claude_env_periods_extend_check" CHECK("claude_env_periods"."extend_status" IN ('none','pending','extending','done','failed'))
);
--> statement-breakpoint
CREATE INDEX `claude_env_periods_extend_idx` ON `claude_env_periods` (`extend_status`,`subscription_id`);
--> statement-breakpoint
CREATE TABLE `claude_env_reports` (
	`report_id` text PRIMARY KEY NOT NULL,
	`relay_id` text NOT NULL,
	`received_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claude_env_reports_received_idx` ON `claude_env_reports` (`received_at`);
--> statement-breakpoint
CREATE TABLE `claude_env_events` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text,
	`kind` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `claude_env_events_subscription_idx` ON `claude_env_events` (`subscription_id`,`created_at`);
