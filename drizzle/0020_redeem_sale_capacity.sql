CREATE TABLE redeem_sale_capacity (
 component_id TEXT PRIMARY KEY REFERENCES product_sellable_items(id),
 free_budget INTEGER NOT NULL DEFAULT 0 CHECK (free_budget >= 0),
 generation INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TRIGGER redeem_sale_stock_changed AFTER UPDATE OF status,order_item_id ON stock_entries
WHEN (NEW.status <> OLD.status OR NEW.order_item_id IS NOT OLD.order_item_id)
 AND EXISTS (SELECT 1 FROM redeem_sale_capacity WHERE component_id=NEW.sellable_item_id)
BEGIN
 UPDATE redeem_sale_capacity SET
  free_budget=CASE
   WHEN OLD.status='available' AND NEW.status IN ('reserved','delivered') THEN
    CASE WHEN updated_at>=unixepoch()*1000-30000 THEN free_budget-1 ELSE -1 END
   WHEN OLD.status='reserved' AND NEW.status='available' THEN 0
   ELSE free_budget END,
  updated_at=CASE WHEN OLD.status='reserved' AND NEW.status='available' THEN 0 ELSE updated_at END,
  generation=generation+1 WHERE component_id=NEW.sellable_item_id;
END;
--> statement-breakpoint
CREATE TRIGGER redeem_sale_delivery_changed AFTER UPDATE OF content_encrypted ON delivery_records
WHEN NEW.content_encrypted IS NOT OLD.content_encrypted AND NEW.content_encrypted IS NOT NULL
BEGIN
 UPDATE redeem_sale_capacity SET free_budget=0,updated_at=0,generation=generation+1
 WHERE component_id=(SELECT sellable_item_id FROM shop_order_items WHERE id=NEW.order_item_id);
END;
