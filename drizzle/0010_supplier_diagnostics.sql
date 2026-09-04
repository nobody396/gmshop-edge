CREATE TABLE `supplier_exchange_records` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_order_id` text NOT NULL,
	`account_id` text NOT NULL,
	`direction` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`status` text NOT NULL,
	`object_key` text NOT NULL,
	`http_status` integer,
	`content_type` text,
	`response_bytes` integer,
	`retained_bytes` integer,
	`truncated` integer DEFAULT false NOT NULL,
	`error_code` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`supplier_order_id`) REFERENCES `supplier_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `supplier_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `supplier_exchange_order_idx` ON `supplier_exchange_records` (`supplier_order_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `supplier_exchange_account_idx` ON `supplier_exchange_records` (`account_id`,`started_at`,`id`);