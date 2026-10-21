-- First-touch traffic source (referrer host, utm tags, landing path) captured in
-- a 30-day storefront cookie and attached to each new storefront order.
CREATE TABLE `order_attribution` (
	`order_id` text PRIMARY KEY NOT NULL,
	`source_category` text NOT NULL,
	`referrer_host` text,
	`utm_source` text,
	`utm_medium` text,
	`utm_campaign` text,
	`landing_path` text,
	`first_seen_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `shop_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "order_attribution_category_check" CHECK("order_attribution"."source_category" IN ('search','ai','social','direct','other','unknown'))
);
