-- Warehouse capacity is advisory. Reserving a customer code must not consume
-- upstream capacity; actual redemption still allocates an upstream key.
DROP TRIGGER redeem_sale_stock_changed;
--> statement-breakpoint
CREATE TRIGGER redeem_sale_stock_changed AFTER UPDATE OF status,order_item_id ON stock_entries
WHEN NEW.status <> OLD.status OR NEW.order_item_id IS NOT OLD.order_item_id
BEGIN
 UPDATE redeem_sale_capacity SET free_budget=0,updated_at=0,generation=generation+1
 WHERE component_id=NEW.sellable_item_id;
END;
--> statement-breakpoint
-- This runs inside the same batch as the item insert and code reservation.
-- Competing main-store and supplier orders therefore cannot oversell codes.
CREATE TRIGGER owned_code_checkout_stock BEFORE INSERT ON shop_order_items
WHEN NEW.delivery_component_type='stock'
 AND EXISTS (SELECT 1 FROM shop_orders WHERE id=NEW.order_id AND status='pending_payment')
 AND EXISTS (SELECT 1 FROM product_sellable_items WHERE id=NEW.delivery_component_id AND fulfillment_source='local')
 AND EXISTS (SELECT 1 FROM system_settings,json_each(CASE WHEN json_type(system_settings.value)='text' THEN json_extract(system_settings.value,'$') ELSE system_settings.value END)
  WHERE system_settings.key='integration.supply_console_map' AND json_each.key=NEW.delivery_component_id)
 AND (SELECT COUNT(*) FROM stock_entries WHERE sellable_item_id=NEW.delivery_component_id AND status='available') < NEW.quantity
BEGIN
 SELECT RAISE(ABORT, 'owned_code_stock_unavailable');
END;
