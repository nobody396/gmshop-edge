ALTER TABLE products ADD COLUMN sale_disabled INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE product_sellable_items ADD COLUMN sale_disabled INTEGER NOT NULL DEFAULT 0;
