-- Owner approvals sent as Telegram inline buttons (e.g. switch a delisted supplier SKU).
CREATE TABLE `owner_action_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`message_text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`chat_id` text,
	`message_id` integer,
	`decided_by` text,
	`decided_at` integer,
	`result` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "owner_action_requests_status_check" CHECK("owner_action_requests"."status" IN ('pending','processing','approved','rejected','failed','expired'))
);
--> statement-breakpoint
CREATE INDEX `owner_action_requests_status_idx` ON `owner_action_requests` (`status`,`expires_at`);
