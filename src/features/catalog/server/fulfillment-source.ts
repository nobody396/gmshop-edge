import { assertSupplierAvailability } from "#/features/storefront/server/multi-order";
import { supplierFallbackEnabledExpression } from "#/features/storefront/server/stock-availability";
import { DomainError } from "#/lib/domain-error";

export type StockFulfillmentMode = "local" | "supplier";

type SourceState = {
	id: string;
	fulfillment_source: string;
	binding_id: string | null;
	reference_cost_minor: string | null;
	available_stock: number;
	supplier_fallback_enabled: number;
};

export async function switchStockFulfillmentMode(
	db: D1Database,
	sellableItemId: string,
	mode: StockFulfillmentMode,
	now = Date.now(),
) {
	const row = await db
		.prepare(`SELECT item.id, item.fulfillment_source,
  binding.id AS binding_id, binding.reference_cost_minor,
  ${supplierFallbackEnabledExpression("item")} AS supplier_fallback_enabled,
  (SELECT COUNT(*) FROM stock_entries stock WHERE stock.sellable_item_id=item.id
   AND stock.status='available') AS available_stock
  FROM product_sellable_items item JOIN products product ON product.id=item.product_id
  LEFT JOIN supplier_bindings binding ON binding.sellable_item_id=item.id AND binding.enabled=1
  WHERE item.id=? AND item.enabled=1 AND product.product_type='stock' LIMIT 1`)
		.bind(sellableItemId)
		.first<SourceState>();
	if (!row)
		throw new DomainError(
			"stock_sellable_item_not_found",
			404,
			"Enabled stock sellable item not found",
		);
	if (!row.binding_id)
		throw new DomainError(
			"supplier_binding_missing",
			409,
			"An enabled supplier binding is required before changing supply mode",
		);
	if (row.fulfillment_source === mode && !row.supplier_fallback_enabled)
		return { id: row.id, mode, duplicate: true };
	if (mode === "local") {
		if (row.fulfillment_source !== mode && row.available_stock < 1)
			throw new DomainError(
				"local_inventory_empty",
				409,
				"Import at least one available inventory entry before switching to local stock",
			);
	} else {
		try {
			await assertSupplierAvailability(db, row.id, 1, now);
		} catch (error) {
			if (
				error instanceof DomainError &&
				[
					"supplier_inventory_unavailable",
					"supplier_account_unavailable",
				].includes(error.code)
			)
				throw new DomainError(
					"supplier_not_ready",
					409,
					"Synchronize and verify supplier stock, price ceiling and sufficient purchasing balance",
				);
			throw error;
		}
	}
	const statements = [
		db
			.prepare(`UPDATE product_sellable_items
  SET fulfillment_source=?,supplier_status=?,cost_minor=CASE WHEN ?='supplier' THEN ? ELSE cost_minor END,updated_at=?
  WHERE id=? AND fulfillment_source=?`)
			.bind(
				mode,
				mode === "supplier" ? "available" : null,
				mode,
				row.reference_cost_minor,
				now,
				row.id,
				row.fulfillment_source,
			),
	];
	// A manual selection means exactly that mode, never a hidden fallback policy.
	if (row.supplier_fallback_enabled)
		statements.push(
			db.prepare(
				"SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('fulfillment_source_conflict','$') END",
			),
			db
				.prepare(
					"UPDATE system_settings SET value='false',updated_at=? WHERE key=?",
				)
				.bind(now, `fulfillment.supplier_fallback.${row.id}`),
		);
	const results = await db.batch(statements);
	if (Number(results[0]?.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"fulfillment_source_conflict",
			409,
			"Supply mode changed concurrently; reload before retrying",
		);
	return { id: row.id, mode, duplicate: false };
}
