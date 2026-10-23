-- Supplier-funded stock is computed (binding snapshot x supplier balance x
-- account health), so balance syncs, top-ups and snapshot expiry change what
-- the supplier API exports without touching any export row timestamp.
-- These columns remember the last exported quantity per listing; the catalog
-- bumps exported_stock_changed_at whenever the computed quantity differs, so
-- incremental partner syncs see the change on their next poll (2026-10-23).
ALTER TABLE `supplier_export_listings` ADD `exported_stock_quantity` integer;
--> statement-breakpoint
ALTER TABLE `supplier_export_listings` ADD `exported_stock_changed_at` integer;
