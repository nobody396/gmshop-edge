ALTER TABLE delivery_records ADD COLUMN redeem_sku TEXT;
--> statement-breakpoint
ALTER TABLE stock_entries ADD COLUMN redeem_sku TEXT;
--> statement-breakpoint
-- Capture the routing choice in the same transaction as allocation. Existing records remain NULL.
CREATE TRIGGER delivery_redeem_route_snapshot AFTER INSERT ON delivery_records
WHEN NEW.delivery_type = 'stock'
BEGIN
  UPDATE delivery_records SET redeem_sku = (
    SELECT json_extract(setting.value, '$')
    FROM shop_order_items item JOIN system_settings setting
      ON setting.key IN ('integration.redeem_delivery.' || item.delivery_component_id,
        'integration.redeem_delivery_trial.' || item.order_id || '.' || item.delivery_component_id)
    WHERE item.id = NEW.order_item_id
      AND json_extract(setting.value, '$') IN ('GPT_PLUS_PH','GPT_5X_PH','GPT_20X_PH')
    ORDER BY CASE WHEN setting.key LIKE 'integration.redeem_delivery_trial.%' THEN 0 ELSE 1 END LIMIT 1
  ) WHERE id = NEW.id;
END;
