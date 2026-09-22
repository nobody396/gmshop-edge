import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import {
	loadDeliveryWarehouseToken,
	requestWarehouse,
} from "#/features/redeem-warehouse/server/warehouse-client";
import { getAdminRuntimeServerContext } from "#/server/context";

// One storefront SKU maps to at most one central credential pool. The map is
// central binding; raw PH stock additionally requires its live delivery route.
export const supplyMapKey = "integration.supply_console_map";

const warehouseSummarySchema = z.object({
	success: z.literal(true),
	data: z.array(
		z.object({
			sku: z.string(),
			display_name: z.string(),
			available: z.number().int().nonnegative(),
			consumed: z.number().int().nonnegative(),
			quarantined: z.number().int().nonnegative(),
		}),
	),
});

type SkuRow = {
	component_id: string;
	product_name: string;
	item_name: string;
	fulfillment_source: string;
	cost_minor: string | null;
	usdt_minor: string | null;
	alipay_minor: string | null;
	supply_minor: string | null;
	available: number | null;
	raw_available: number | null;
	delivery_sku: string | null;
	reserved: number | null;
	last_restocked_at: number | null;
	last_unit_cost_minor: string | null;
	binding_provider: string | null;
	binding_product: string | null;
	binding_status: string | null;
	binding_stock: number | null;
};

export const listSupplyConsoleFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("inventory", "read"),
		);
		return listSupplyConsole(context.db, context.runtime.commerceSecret);
	},
);

export async function listSupplyConsole(
	db: D1Database,
	commerceSecret: string,
	requester: typeof requestWarehouse = requestWarehouse,
) {
	const [rows, map] = await Promise.all([
		db
			.prepare(
				`SELECT item.id AS component_id, product.name AS product_name,
				 item.name AS item_name, item.fulfillment_source, item.cost_minor,
				 (SELECT price.price_minor FROM sellable_item_channel_prices price
				  JOIN payment_channels channel ON channel.id = price.channel_id
				  WHERE price.sellable_item_id = item.id AND price.enabled = 1
				   AND channel.name = 'USDT') AS usdt_minor,
				 (SELECT price.price_minor FROM sellable_item_channel_prices price
				  JOIN payment_channels channel ON channel.id = price.channel_id
				  WHERE price.sellable_item_id = item.id AND price.enabled = 1
				   AND channel.name = '支付宝') AS alipay_minor,
				 (SELECT listing.price_minor FROM supplier_export_listings listing
				  WHERE listing.sellable_item_id = item.id AND listing.enabled = 1) AS supply_minor,
				 (SELECT COUNT(*) FROM stock_entries stock
				  WHERE stock.sellable_item_id = item.id AND stock.status = 'available') AS available,
				 (SELECT COUNT(*) FROM stock_entries stock
				  WHERE stock.sellable_item_id = item.id AND stock.status = 'available'
				   AND stock.redeem_sku IS NULL) AS raw_available,
				 (SELECT json_extract(setting.value, '$') FROM system_settings setting
				  WHERE setting.key = 'integration.redeem_delivery.' || item.id) AS delivery_sku,
				 (SELECT COUNT(*) FROM stock_entries stock
				  WHERE stock.sellable_item_id = item.id AND stock.status = 'reserved') AS reserved,
				 (SELECT MAX(stock.created_at) FROM stock_entries stock
				  WHERE stock.sellable_item_id = item.id) AS last_restocked_at,
				 (SELECT stock.unit_cost_minor FROM stock_entries stock
				  WHERE stock.sellable_item_id = item.id AND stock.unit_cost_minor IS NOT NULL
				  ORDER BY stock.created_at DESC LIMIT 1) AS last_unit_cost_minor,
				 binding.provider AS binding_provider,
				 binding.upstream_product_name AS binding_product,
				 binding.remote_status AS binding_status,
				 binding.stock_quantity AS binding_stock
				 FROM product_sellable_items item
				 JOIN products product ON product.id = item.product_id
				 LEFT JOIN supplier_bindings binding
				  ON binding.sellable_item_id = item.id AND binding.enabled = 1
				 WHERE item.enabled = 1 AND item.sale_disabled = 0
				  AND product.status = 'active' AND product.sale_disabled = 0
				  AND product.product_type = 'stock'
				 ORDER BY product.sort_order, item.sort_order, item.name`,
			)
			.all<SkuRow>(),
		loadSupplyMap(db),
	]);
	const pools = Object.values(map).length
		? await warehousePools(db, commerceSecret, requester)
		: new Map<string, { available: number; displayName: string }>();
	return rows.results.map((row) => {
		const centralSku = map[row.component_id] ?? null;
		const pool = centralSku ? (pools.get(centralSku) ?? null) : null;
		const available = Number(row.available ?? 0);
		// PH raw cards enter the central vault only during paid-order delivery.
		// Count them once, only with an exact active conversion route; ordinary
		// storefront codes still require independently stocked central keys.
		const rawAvailable =
			centralSku &&
			row.delivery_sku === centralSku &&
			["GPT_PLUS_PH", "GPT_5X_PH", "GPT_20X_PH"].includes(centralSku)
				? Number(row.raw_available ?? 0)
				: 0;
		const deliverable = centralSku
			? rawAvailable + Math.min(available - rawAvailable, pool?.available ?? 0)
			: row.fulfillment_source === "supplier"
				? Number(row.binding_stock ?? 0)
				: available;
		return {
			componentId: row.component_id,
			productName: row.product_name,
			itemName: row.item_name,
			mode: row.fulfillment_source as "local" | "supplier" | "manual",
			usdtMinor: row.usdt_minor,
			alipayMinor: row.alipay_minor,
			supplyMinor: row.supply_minor,
			costMinor: row.cost_minor,
			lastUnitCostMinor: row.last_unit_cost_minor,
			available,
			reserved: Number(row.reserved ?? 0),
			deliverable,
			gap: Math.max(0, available - deliverable),
			lastRestockedAt: row.last_restocked_at,
			centralSku,
			centralAvailable: pool?.available ?? null,
			centralName: pool?.displayName ?? null,
			binding: row.binding_provider
				? {
						provider: row.binding_provider,
						product: row.binding_product,
						status: row.binding_status,
						stock: Number(row.binding_stock ?? 0),
					}
				: null,
		};
	});
}

export async function loadSupplyMap(
	db: D1Database,
): Promise<Record<string, string>> {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key = ?")
		.bind(supplyMapKey)
		.first<{ value: string }>();
	if (!row?.value) return {};
	const value: unknown = JSON.parse(row.value);
	// Accept normal JSON objects and legacy JSON-encoded strings.
	const parsed = z
		.record(z.string(), z.string())
		.safeParse(typeof value === "string" ? JSON.parse(value || "{}") : value);
	return parsed.success ? parsed.data : {};
}

async function warehousePools(
	db: D1Database,
	commerceSecret: string,
	requester: typeof requestWarehouse,
) {
	if (!commerceSecret) return new Map<string, never>();
	try {
		const token = await loadDeliveryWarehouseToken(db, commerceSecret);
		const summary = warehouseSummarySchema.parse(
			await requester(token, "/api/internal/inventory/summary"),
		);
		return new Map(
			summary.data.map((pool) => [
				pool.sku,
				{ available: pool.available, displayName: pool.display_name },
			]),
		);
	} catch {
		// A warehouse outage must not blank the console; pools read as unknown.
		return new Map<string, { available: number; displayName: string }>();
	}
}
