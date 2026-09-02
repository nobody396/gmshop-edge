import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	formatFeishuOwnerSaleAlert,
	publishPendingOwnerSaleAlerts,
} from "#/features/notifications/server/owner-sale-alerts";
import { applyMigrations } from "./migrations";

describe("owner sale alerts", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seedSale(db);
	});

	afterEach(async () => miniflare.dispose());

	it("sends one idempotent sale message with the current Aisou balance", async () => {
		const messages: string[] = [];
		await expect(
			publishPendingOwnerSaleAlerts({
				db,
				now: Date.parse("2026-09-02T13:00:00Z"),
				readBalance: async () => ({
					amountMinor: "46700",
					currency: "CNY",
					currencyDecimals: 2,
					fresh: true,
				}),
				deliver: async (text) => {
					messages.push(text);
				},
			}),
		).resolves.toEqual({ scanned: 1, sent: 1, deferred: 0, failed: 0 });
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("💰 老实人VIP新订单");
		expect(messages[0]).toContain("商品：ChatGPT会员 · Plus菲区 × 1");
		expect(messages[0]).toContain("实收：¥119.00");
		expect(messages[0]).toContain("Aisou剩余额度：¥467.00");
		await expect(
			publishPendingOwnerSaleAlerts({
				db,
				readBalance: async () => null,
				deliver: async (text) => {
					messages.push(text);
				},
			}),
		).resolves.toEqual({ scanned: 0, sent: 0, deferred: 0, failed: 0 });
		expect(messages).toHaveLength(1);
	});

	it("waits for automatic supply before reading the post-purchase balance", async () => {
		await seedPendingSupplierOrder(db);
		const balances: string[] = [];
		const messages: string[] = [];
		const now = Date.parse("2026-09-02T13:00:00Z");
		await expect(
			publishPendingOwnerSaleAlerts({
				db,
				now,
				readBalance: async () => {
					balances.push("read");
					return null;
				},
				deliver: async (text) => {
					messages.push(text);
				},
			}),
		).resolves.toEqual({ scanned: 1, sent: 0, deferred: 1, failed: 0 });
		expect(balances).toHaveLength(0);
		expect(messages).toHaveLength(0);

		await db
			.prepare(
				"UPDATE supplier_orders SET state = 'supplied' WHERE id = 'supplier-order'",
			)
			.run();
		await expect(
			publishPendingOwnerSaleAlerts({
				db,
				now: now + 15_000,
				readBalance: async () => ({
					amountMinor: "38500",
					currency: "CNY",
					currencyDecimals: 2,
					fresh: true,
				}),
				deliver: async (text) => {
					messages.push(text);
				},
			}),
		).resolves.toEqual({ scanned: 1, sent: 1, deferred: 0, failed: 0 });
		expect(messages[0]).toContain("交付：自动交付完成");
		expect(messages[0]).toContain("Aisou剩余额度：¥385.00");
	});
});

it("formats cached balances explicitly", () => {
	const text = formatFeishuOwnerSaleAlert(
		{
			order_number: "GMTEST",
			order_status: "paid",
			currency: "CNY",
			currency_decimals: 2,
			total_minor: "4000",
			items_summary: "Grok会员 · SuperGrok 3个月 × 1",
			supplier_item_count: 0,
			manual_item_count: 1,
			supplier_pending_count: 0,
			supplier_failed_count: 0,
			payment_channel: "支付宝",
		},
		{
			amountMinor: "50000",
			currency: "CNY",
			currencyDecimals: 2,
			fresh: false,
		},
	);
	expect(text).toContain("Aisou剩余额度：¥500.00（缓存）");
});

async function seedSale(db: D1Database) {
	await db.batch([
		db.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, created_at, updated_at)
			 VALUES ('product', 'ChatGPT会员', 'stock', 'active', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, supplier_status,
			  currency, currency_decimals, price_minor, created_at, updated_at)
			 VALUES ('sellable', 'product', 'Plus菲区', 'manual', NULL,
			  'CNY', 2, '11900', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO shop_orders
			 (id, order_number, status, currency, currency_decimals, subtotal_minor,
			  total_minor, paid_minor, expires_at, paid_at, created_at, updated_at)
			 VALUES ('order', 'GMTEST', 'paid', 'CNY', 2, '11900', '11900',
			  '11900', 9999999999999, 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, product_name,
			  delivery_component_id, delivery_component_type,
			  delivery_component_version, sellable_item_name, quantity,
			  unit_price_minor, subtotal_minor, created_at, updated_at)
			 VALUES ('item', 'order', 'product', 'sellable', 'ChatGPT会员',
			  'sellable', 'stock', 1, 'Plus菲区', 1, '11900', '11900', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key,
			  payload, status, attempt_count, created_at, updated_at)
			 VALUES ('alert', 'owner.sale_alert', 'shop_order', 'order', 'owner-sale-order:order',
			  '{"orderId":"order"}', 'pending', 0, 1, 1)`,
		),
	]);
}

async function seedPendingSupplierOrder(db: D1Database) {
	await db.batch([
		db.prepare(
			`UPDATE product_sellable_items SET fulfillment_source = 'supplier',
			 supplier_status = 'available' WHERE id = 'sellable'`,
		),
		db.prepare(
			`INSERT INTO supplier_bindings
			 (id, sellable_item_id, provider, normalized_api_origin,
			  protocol_version, upstream_product_id, upstream_sku_id,
			  upstream_product_name, upstream_sku_name, reference_cost_minor,
			  max_cost_minor, stock_quantity, remote_status, last_synced_at,
			  enabled, created_at, updated_at)
			 VALUES ('binding', 'sellable', 'shared_stock', 'https://aisou.pro',
			  'acg-sharedstock-v1', 'product', 'sku', 'Product', 'SKU', '11500',
			  '12000', 10, 'active', 1, 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO delivery_records
			 (id, order_item_id, delivery_type, request_key, status, created_at, updated_at)
			 VALUES ('delivery', 'item', 'stock', 'initial:item',
			  'awaiting_supply', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO supplier_orders
			 (id, order_id, order_item_id, delivery_record_id, supplier_binding_id,
			  quantity, currency, binding_snapshot_json, state, created_at, updated_at)
			 VALUES ('supplier-order', 'order', 'item', 'delivery', 'binding', 1,
			  'CNY', '{}', 'pending', 1, 1)`,
		),
	]);
}
