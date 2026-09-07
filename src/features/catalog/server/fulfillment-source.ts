import { SUPPLIER_SNAPSHOT_MAX_AGE_MS } from "#/features/storefront/server/stock-availability";
import { DomainError } from "#/lib/domain-error";

export type StockFulfillmentMode = "local" | "supplier";

type SourceState = {
	id: string;
	fulfillment_source: string;
	supplier_status: string | null;
	binding_id: string | null;
	provider: string | null;
	normalized_api_origin: string | null;
	protocol_version: string | null;
	reference_cost_minor: string | null;
	max_cost_minor: string | null;
	stock_quantity: number | null;
	remote_status: string | null;
	last_synced_at: number | null;
	available_stock: number;
	eligible_accounts: number;
};

export async function switchStockFulfillmentMode(
	db: D1Database,
	sellableItemId: string,
	mode: StockFulfillmentMode,
	now = Date.now(),
) {
	const row = await db
		.prepare(
			`SELECT item.id, item.fulfillment_source, item.supplier_status,
			 binding.id AS binding_id, binding.provider,
			 binding.normalized_api_origin, binding.protocol_version,
			 binding.reference_cost_minor, binding.max_cost_minor,
			 binding.stock_quantity, binding.remote_status, binding.last_synced_at,
			 (SELECT COUNT(*) FROM stock_entries stock
			  WHERE stock.sellable_item_id = item.id
			   AND stock.status = 'available') AS available_stock,
			 (SELECT COUNT(*) FROM supplier_accounts account
			  WHERE account.provider = binding.provider
			   AND account.normalized_api_origin = binding.normalized_api_origin
			   AND account.protocol_version = binding.protocol_version
			   AND account.enabled = 1
			   AND account.health_status <> 'unavailable'
			   AND (account.cooldown_until IS NULL OR account.cooldown_until <= ?)
			   AND account.balance_minor IS NOT NULL) AS eligible_accounts
			 FROM product_sellable_items item
			 JOIN products product ON product.id = item.product_id
			 LEFT JOIN supplier_bindings binding
			  ON binding.sellable_item_id = item.id AND binding.enabled = 1
			 WHERE item.id = ? AND item.enabled = 1
			  AND product.product_type = 'stock' LIMIT 1`,
		)
		.bind(now, sellableItemId)
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
	if (row.fulfillment_source === mode)
		return { id: row.id, mode, duplicate: true };

	if (mode === "local") {
		if (row.available_stock < 1)
			throw new DomainError(
				"local_inventory_empty",
				409,
				"Import at least one available inventory entry before switching to local stock",
			);
	} else {
		const fresh =
			row.last_synced_at != null &&
			row.last_synced_at >= now - SUPPLIER_SNAPSHOT_MAX_AGE_MS;
		const costAllowed =
			row.reference_cost_minor != null &&
			row.max_cost_minor != null &&
			compareUnsignedIntegerStrings(
				row.reference_cost_minor,
				row.max_cost_minor,
			) <= 0;
		if (
			row.remote_status !== "active" ||
			!fresh ||
			Number(row.stock_quantity ?? 0) < 1 ||
			!costAllowed ||
			Number(row.eligible_accounts ?? 0) < 1
		)
			throw new DomainError(
				"supplier_not_ready",
				409,
				"Synchronize the supplier and require fresh stock, an allowed cost, and an eligible purchasing account before restoring it",
			);
	}

	const supplierStatus = mode === "supplier" ? "available" : null;
	const result = await db
		.prepare(
			`UPDATE product_sellable_items
			 SET fulfillment_source = ?, supplier_status = ?,
			  cost_minor = CASE WHEN ? = 'supplier' THEN ? ELSE cost_minor END,
			  updated_at = ?
			 WHERE id = ? AND fulfillment_source = ?`,
		)
		.bind(
			mode,
			supplierStatus,
			mode,
			row.reference_cost_minor,
			now,
			row.id,
			row.fulfillment_source,
		)
		.run();
	if (Number(result.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"fulfillment_source_conflict",
			409,
			"Supply mode changed concurrently; reload before retrying",
		);
	return { id: row.id, mode, duplicate: false };
}

function compareUnsignedIntegerStrings(left: string, right: string) {
	const a = left.replace(/^0+(?=\d)/, "");
	const b = right.replace(/^0+(?=\d)/, "");
	if (a.length !== b.length) return a.length < b.length ? -1 : 1;
	return a.localeCompare(b);
}
