import { DomainError } from "#/lib/domain-error";
import type { SupplierProduct } from "../providers/types";
import type { SupplierSourceIdentity } from "./source-sync";

export type SwitchTarget = {
	id: string;
	currency: string;
	currency_decimals: number;
	binding_id: string;
	provider: string;
	normalized_api_origin: string;
	protocol_version: string;
	max_cost_minor: string;
};

/** The supplier-fulfilled stock item and its one enabled binding. */
export function loadSwitchTarget(db: D1Database, sellableItemId: string) {
	return db
		.prepare(
			`SELECT psi.id, psi.currency, psi.currency_decimals,
			        sb.id AS binding_id, sb.provider,
			        sb.normalized_api_origin, sb.protocol_version, sb.max_cost_minor
			 FROM product_sellable_items psi
			 JOIN products p ON p.id = psi.product_id
			 JOIN supplier_bindings sb ON sb.sellable_item_id = psi.id
			  AND sb.enabled = 1
			 WHERE psi.id = ? AND psi.fulfillment_source = 'supplier'
			  AND p.product_type = 'stock' LIMIT 1`,
		)
		.bind(sellableItemId)
		.first<SwitchTarget>();
}

export async function assertSupplierSkuUnbound(
	db: D1Database,
	source: SupplierSourceIdentity,
	productId: string,
	skuId: string,
) {
	const duplicate = await db
		.prepare(
			`SELECT 1 FROM supplier_bindings WHERE provider = ?
			 AND normalized_api_origin = ? AND protocol_version = ?
			 AND upstream_product_id = ? AND upstream_sku_id = ?
			 AND enabled = 1 LIMIT 1`,
		)
		.bind(
			source.provider,
			source.normalizedApiOrigin,
			source.protocolVersion,
			productId,
			skuId,
		)
		.first();
	if (duplicate)
		throw new DomainError(
			"supplier_binding_duplicate",
			409,
			"Supplier SKU is already bound",
		);
}

/**
 * Disables the target's current binding and binds the item to a new upstream
 * SKU from the synchronized catalog. The caller adds its own audit statement.
 */
export function switchSupplierBindingStatements(
	db: D1Database,
	input: {
		target: SwitchTarget;
		source: SupplierSourceIdentity;
		product: SupplierProduct;
		sku: SupplierProduct["skus"][number];
		syncedAt: number;
		maxCostMinor: string;
		now: number;
	},
) {
	const { target, source, product, sku, now } = input;
	const active = product.active && sku.active;
	const bindingId = crypto.randomUUID();
	return {
		bindingId,
		statements: [
			db
				.prepare(
					`UPDATE supplier_bindings SET enabled = 0, updated_at = ?
					 WHERE id = ? AND enabled = 1`,
				)
				.bind(now, target.binding_id),
			db
				.prepare(
					`INSERT INTO supplier_bindings
					 (id, sellable_item_id, provider, normalized_api_origin,
					  protocol_version, upstream_product_id, upstream_sku_id,
					  upstream_product_name, upstream_sku_name, reference_cost_minor,
					  max_cost_minor, stock_quantity, remote_status, last_synced_at,
					  enabled, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
				)
				.bind(
					bindingId,
					target.id,
					source.provider,
					source.normalizedApiOrigin,
					source.protocolVersion,
					product.id,
					sku.id,
					product.name,
					sku.name,
					sku.costMinor,
					input.maxCostMinor,
					sku.stockQuantity,
					active ? "active" : "inactive",
					input.syncedAt,
					now,
					now,
				),
			db
				.prepare(
					`UPDATE product_sellable_items SET supplier_status = ?,
					 cost_minor = ?, updated_at = ? WHERE id = ?`,
				)
				.bind(
					active ? "available" : "unavailable",
					sku.costMinor,
					now,
					target.id,
				),
		],
	};
}
