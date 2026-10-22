-- Volume pricing, per-customer prices and bulk AISOU procurement (2026-10-22).
CREATE TABLE `sellable_item_volume_prices` (
	`sellable_item_id` text NOT NULL,
	`min_quantity` integer NOT NULL,
	`discount_minor` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`sellable_item_id`, `min_quantity`),
	FOREIGN KEY (`sellable_item_id`) REFERENCES `product_sellable_items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sellable_item_volume_prices_min_quantity_check" CHECK("sellable_item_volume_prices"."min_quantity" BETWEEN 2 AND 1000),
	CONSTRAINT "sellable_item_volume_prices_discount_check" CHECK("discount_minor" <> '' AND "discount_minor" NOT GLOB '*[^0-9]*')
);
--> statement-breakpoint
CREATE TABLE `customer_item_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`sellable_item_id` text NOT NULL,
	`min_quantity` integer DEFAULT 1 NOT NULL,
	`price_minor` text NOT NULL,
	`channel_prices_json` text DEFAULT '{}' NOT NULL,
	`cost_minor_at_set` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sellable_item_id`) REFERENCES `product_sellable_items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "customer_item_prices_min_quantity_check" CHECK("customer_item_prices"."min_quantity" BETWEEN 1 AND 1000),
	CONSTRAINT "customer_item_prices_price_check" CHECK("price_minor" <> '' AND "price_minor" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "customer_item_prices_channel_prices_check" CHECK(json_valid("customer_item_prices"."channel_prices_json") AND json_type("customer_item_prices"."channel_prices_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_item_prices_scope_uidx` ON `customer_item_prices` (`user_id`,`sellable_item_id`,`min_quantity`);
--> statement-breakpoint
CREATE INDEX `customer_item_prices_item_idx` ON `customer_item_prices` (`sellable_item_id`);
--> statement-breakpoint
CREATE TABLE `bulk_procurements` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`sellable_item_id` text NOT NULL,
	`warehouse_sku` text NOT NULL,
	`quantity` integer NOT NULL,
	`code_hashes_json` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`accept_unit_minor` text,
	`last_result_json` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`notified_state` text,
	`owner_action_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "bulk_procurements_state_check" CHECK("state" IN ('pending','verifying','awaiting_funds','awaiting_stock','awaiting_price','supplied','review','skipped','cancelled')),
	CONSTRAINT "bulk_procurements_code_hashes_check" CHECK(json_valid("bulk_procurements"."code_hashes_json") AND json_type("bulk_procurements"."code_hashes_json") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bulk_procurements_order_item_uidx` ON `bulk_procurements` (`order_item_id`);
--> statement-breakpoint
CREATE INDEX `bulk_procurements_state_idx` ON `bulk_procurements` (`state`,`next_attempt_at`);
--> statement-breakpoint
-- Which price an order line was sold at: the list price, a public volume step or a customer price.
ALTER TABLE `shop_order_items` ADD `price_source` text DEFAULT 'list' NOT NULL;
