CREATE TRIGGER stock_entries_inventory_insert
AFTER INSERT ON stock_entries
WHEN NEW.status = 'available' AND EXISTS (
	SELECT 1 FROM supplier_export_listings listing
	WHERE listing.sellable_item_id = NEW.sellable_item_id AND listing.enabled = 1
)
BEGIN
	INSERT OR IGNORE INTO outbox_events
		(id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
		 status, attempt_count, created_at, updated_at)
	VALUES
		('inventory-insert:' || NEW.sellable_item_id || ':' || NEW.updated_at,
		 'inventory.changed', 'sellable_item', NEW.sellable_item_id,
		 'inventory-insert:' || NEW.sellable_item_id || ':' || NEW.updated_at,
		 json_object('sellableItemId', NEW.sellable_item_id, 'changedAt', NEW.updated_at),
		 'pending', 0, NEW.updated_at, NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER stock_entries_inventory_update
AFTER UPDATE OF status, sellable_item_id ON stock_entries
WHEN (
	(OLD.status = 'available') <> (NEW.status = 'available')
	OR OLD.sellable_item_id <> NEW.sellable_item_id
) AND EXISTS (
	SELECT 1 FROM supplier_export_listings listing
	WHERE listing.sellable_item_id IN (OLD.sellable_item_id, NEW.sellable_item_id)
	 AND listing.enabled = 1
)
BEGIN
	INSERT OR IGNORE INTO outbox_events
		(id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
		 status, attempt_count, created_at, updated_at)
	VALUES
		('inventory-update:' || NEW.sellable_item_id || ':' || NEW.updated_at,
		 'inventory.changed', 'sellable_item', NEW.sellable_item_id,
		 'inventory-update:' || NEW.sellable_item_id || ':' || NEW.updated_at,
		 json_object('sellableItemId', NEW.sellable_item_id, 'changedAt', NEW.updated_at),
		 'pending', 0, NEW.updated_at, NEW.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER stock_entries_inventory_delete
AFTER DELETE ON stock_entries
WHEN OLD.status = 'available' AND EXISTS (
	SELECT 1 FROM supplier_export_listings listing
	WHERE listing.sellable_item_id = OLD.sellable_item_id AND listing.enabled = 1
)
BEGIN
	INSERT OR IGNORE INTO outbox_events
		(id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
		 status, attempt_count, created_at, updated_at)
	VALUES
		('inventory-delete:' || OLD.sellable_item_id || ':' || OLD.updated_at,
		 'inventory.changed', 'sellable_item', OLD.sellable_item_id,
		 'inventory-delete:' || OLD.sellable_item_id || ':' || OLD.updated_at,
		 json_object('sellableItemId', OLD.sellable_item_id, 'changedAt', OLD.updated_at),
		 'pending', 0, OLD.updated_at, OLD.updated_at);
END;
