ALTER TABLE `stock_entries` ADD `procurement_source` text;
--> statement-breakpoint
ALTER TABLE `stock_entries` ADD `procurement_request_ref` text;
--> statement-breakpoint
ALTER TABLE `stock_entries` ADD `unit_cost_minor` text;
--> statement-breakpoint
CREATE INDEX `stock_entries_procurement_status_idx` ON `stock_entries` (`procurement_source`,`sellable_item_id`,`status`,`created_at`);
