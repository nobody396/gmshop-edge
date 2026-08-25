CREATE TABLE `sellable_item_channel_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`sellable_item_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`price_minor` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`sellable_item_id`) REFERENCES `product_sellable_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `payment_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sellable_item_channel_prices_price_minor_check" CHECK("price_minor" <> '' AND "price_minor" NOT GLOB '*[^0-9]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sellable_item_channel_prices_item_channel_uidx` ON `sellable_item_channel_prices` (`sellable_item_id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `sellable_item_channel_prices_channel_enabled_idx` ON `sellable_item_channel_prices` (`channel_id`,`enabled`,`sellable_item_id`);