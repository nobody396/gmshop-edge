PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_sellable_items_supplier_stock_insert_trigger`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `product_sellable_items_supplier_stock_update_trigger`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `products_supplier_stock_type_trigger`;--> statement-breakpoint
CREATE TABLE `__new_product_sellable_items` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`duration_ms` integer,
	`usage_limit` integer,
	`access_limit` integer,
	`renewal_mode` text DEFAULT 'stack' NOT NULL,
	`email_mode` text DEFAULT 'none' NOT NULL,
	`show_on_order_page` integer DEFAULT true NOT NULL,
	`allow_resend` integer DEFAULT true NOT NULL,
	`fulfillment_source` text DEFAULT 'local' NOT NULL,
	`supplier_status` text,
	`low_stock_threshold` integer DEFAULT 5 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`automation_provider` text,
	`automation_base_url` text,
	`automation_repository_owner` text,
	`automation_repository_name` text,
	`automation_default_branch` text,
	`automation_workflow_file` text,
	`automation_credential_encrypted` text,
	`automation_credential_key_version` integer,
	`active_definition_version_id` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`currency_decimals` integer DEFAULT 2 NOT NULL,
	`list_price_minor` text,
	`price_minor` text NOT NULL,
	`cost_minor` text,
	`minimum_quantity` integer DEFAULT 1 NOT NULL,
	`maximum_quantity` integer DEFAULT 1 NOT NULL,
	`maximum_per_customer` integer,
	`sort_order` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_sellable_items_price_minor_check" CHECK("price_minor" <> '' AND "price_minor" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "product_sellable_items_list_price_minor_check" CHECK("__new_product_sellable_items"."list_price_minor" IS NULL OR ("list_price_minor" <> '' AND "list_price_minor" NOT GLOB '*[^0-9]*')),
	CONSTRAINT "product_sellable_items_cost_minor_check" CHECK("__new_product_sellable_items"."cost_minor" IS NULL OR ("cost_minor" <> '' AND "cost_minor" NOT GLOB '*[^0-9]*')),
	CONSTRAINT "product_sellable_items_currency_decimals_check" CHECK("__new_product_sellable_items"."currency_decimals" BETWEEN 0 AND 8),
	CONSTRAINT "product_sellable_items_minimum_quantity_check" CHECK("__new_product_sellable_items"."minimum_quantity" > 0),
	CONSTRAINT "product_sellable_items_maximum_quantity_check" CHECK("__new_product_sellable_items"."maximum_quantity" >= "__new_product_sellable_items"."minimum_quantity"),
	CONSTRAINT "product_sellable_items_maximum_per_customer_check" CHECK("__new_product_sellable_items"."maximum_per_customer" IS NULL OR "__new_product_sellable_items"."maximum_per_customer" > 0),
	CONSTRAINT "product_sellable_items_duration_check" CHECK("__new_product_sellable_items"."duration_ms" IS NULL OR "__new_product_sellable_items"."duration_ms" > 0),
	CONSTRAINT "product_sellable_items_usage_limit_check" CHECK("__new_product_sellable_items"."usage_limit" IS NULL OR "__new_product_sellable_items"."usage_limit" > 0),
	CONSTRAINT "product_sellable_items_access_limit_check" CHECK("__new_product_sellable_items"."access_limit" IS NULL OR "__new_product_sellable_items"."access_limit" > 0),
	CONSTRAINT "product_sellable_items_version_check" CHECK("__new_product_sellable_items"."version" > 0),
	CONSTRAINT "product_sellable_items_fulfillment_source_check" CHECK("__new_product_sellable_items"."fulfillment_source" IN ('local', 'manual', 'supplier')),
	CONSTRAINT "product_sellable_items_supplier_status_check" CHECK(("__new_product_sellable_items"."fulfillment_source" IN ('local', 'manual') AND "__new_product_sellable_items"."supplier_status" IS NULL) OR
				("__new_product_sellable_items"."fulfillment_source" = 'supplier' AND "__new_product_sellable_items"."supplier_status" IS NOT NULL)),
	CONSTRAINT "product_sellable_items_automation_credential_check" CHECK(("__new_product_sellable_items"."automation_credential_encrypted" IS NULL AND "__new_product_sellable_items"."automation_credential_key_version" IS NULL) OR
				("__new_product_sellable_items"."automation_credential_encrypted" IS NOT NULL AND "__new_product_sellable_items"."automation_credential_key_version" > 0))
);
--> statement-breakpoint
INSERT INTO `__new_product_sellable_items`("id", "product_id", "name", "duration_ms", "usage_limit", "access_limit", "renewal_mode", "email_mode", "show_on_order_page", "allow_resend", "fulfillment_source", "supplier_status", "low_stock_threshold", "version", "automation_provider", "automation_base_url", "automation_repository_owner", "automation_repository_name", "automation_default_branch", "automation_workflow_file", "automation_credential_encrypted", "automation_credential_key_version", "active_definition_version_id", "currency", "currency_decimals", "list_price_minor", "price_minor", "cost_minor", "minimum_quantity", "maximum_quantity", "maximum_per_customer", "sort_order", "enabled", "created_at", "updated_at") SELECT "id", "product_id", "name", "duration_ms", "usage_limit", "access_limit", "renewal_mode", "email_mode", "show_on_order_page", "allow_resend", "fulfillment_source", "supplier_status", "low_stock_threshold", "version", "automation_provider", "automation_base_url", "automation_repository_owner", "automation_repository_name", "automation_default_branch", "automation_workflow_file", "automation_credential_encrypted", "automation_credential_key_version", "active_definition_version_id", "currency", "currency_decimals", "list_price_minor", "price_minor", "cost_minor", "minimum_quantity", "maximum_quantity", "maximum_per_customer", "sort_order", "enabled", "created_at", "updated_at" FROM `product_sellable_items`;--> statement-breakpoint
DROP TABLE `product_sellable_items`;--> statement-breakpoint
ALTER TABLE `__new_product_sellable_items` RENAME TO `product_sellable_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `product_sellable_items_product_name_uidx` ON `product_sellable_items` (`product_id`,`name`);--> statement-breakpoint
CREATE INDEX `product_sellable_items_product_enabled_sort_idx` ON `product_sellable_items` (`product_id`,`enabled`,`sort_order`,`id`);--> statement-breakpoint
CREATE TRIGGER `product_sellable_items_supplier_stock_insert_trigger`
BEFORE INSERT ON `product_sellable_items`
WHEN NEW.`fulfillment_source` IN ('supplier', 'manual')
 AND NOT EXISTS (
	SELECT 1 FROM `products`
	WHERE `products`.`id` = NEW.`product_id`
	 AND `products`.`product_type` = 'stock'
 )
BEGIN
	SELECT RAISE(ABORT, 'supplier_fulfillment_requires_stock_product');
END;--> statement-breakpoint
CREATE TRIGGER `product_sellable_items_supplier_stock_update_trigger`
BEFORE UPDATE OF `fulfillment_source`, `product_id` ON `product_sellable_items`
WHEN NEW.`fulfillment_source` IN ('supplier', 'manual')
 AND NOT EXISTS (
	SELECT 1 FROM `products`
	WHERE `products`.`id` = NEW.`product_id`
	 AND `products`.`product_type` = 'stock'
 )
BEGIN
	SELECT RAISE(ABORT, 'supplier_fulfillment_requires_stock_product');
END;--> statement-breakpoint
CREATE TRIGGER `products_supplier_stock_type_trigger`
BEFORE UPDATE OF `product_type` ON `products`
WHEN NEW.`product_type` <> 'stock'
 AND EXISTS (
	SELECT 1 FROM `product_sellable_items`
	WHERE `product_sellable_items`.`product_id` = NEW.`id`
	 AND `product_sellable_items`.`fulfillment_source` IN ('supplier', 'manual')
 )
BEGIN
	SELECT RAISE(ABORT, 'supplier_fulfillment_requires_stock_product');
END;
