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
		expect(messages[0]).toContain("商品售价：¥119.00");
		expect(messages[0]).toContain("下单邮箱：未填写");
		expect(messages[0]).toContain("CDK来源：人工采购");
		expect(messages[0]).toContain("采购钱包剩余额度：¥467.00");
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
		expect(messages[0]).toContain("CDK来源：钱包额度下单");
		expect(messages[0]).toContain("采购钱包剩余额度：¥385.00");
	});

	it("uses the order wallet ledger and allocated stock instead of current mutable state", async () => {
		const messages: string[] = [];
		await db.batch([
			db.prepare(
				`INSERT INTO users
				 (id, name, email, email_verified, preferred_locale, enabled,
				  balance_minor, balance_version, role_ids, created_at, updated_at)
				 VALUES ('wallet-user', 'Wallet User', 'wallet@example.com', 1, 'zh-CN', 1,
				  '111', 2, '[]', 1, 2)`,
			),
			db.prepare(
				`UPDATE shop_orders SET user_id='wallet-user', contact_email='wallet@example.com'
				 WHERE id='order'`,
			),
			db.prepare(
				`INSERT INTO wallet_entries
				 (id, user_id, direction, amount_minor, balance_before_minor,
				  balance_after_minor, currency, source_type, source_id,
				  idempotency_key, created_at)
				 VALUES ('wallet-order', 'wallet-user', 'debit', '11900', '12899',
				  '999', 'CNY', 'shop_order', 'order', 'wallet-order:order', 1)`,
			),
			db.prepare(
				`UPDATE product_sellable_items SET fulfillment_source='local',
				 cost_minor='11500' WHERE id='sellable'`,
			),
			db.prepare(
				`UPDATE shop_order_items SET unit_cost_minor='11500' WHERE id='item'`,
			),
			db.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version,
				  content_fingerprint, content_mask, status, order_item_id,
				  unit_cost_minor, created_at, updated_at)
				 VALUES ('allocated-stock', 'sellable', 'ciphertext', 1,
				  'fingerprint', '••••1234', 'delivered', 'item', '11500', 1, 1)`,
			),
		]);
		await publishPendingOwnerSaleAlerts({
			db,
			readBalance: async () => null,
			deliver: async (text) => {
				messages.push(text);
			},
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("下单邮箱：wallet@example.com");
		expect(messages[0]).toContain("支付方式：用户钱包");
		expect(messages[0]).toContain("用户钱包剩余额度：¥9.99");
		expect(messages[0]).not.toContain("¥1.11");
		expect(messages[0]).toContain("CDK来源：内置库存");
		expect(messages[0]).toContain("我们的成本：¥115.00");
		expect(messages[0]).toContain("我们的利润：¥4.00");
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
			contact_email: "buyer@example.com",
			items_summary: "Grok会员 · SuperGrok 3个月 × 1",
			cost_total_minor: "3300",
			cost_missing_count: 0,
			local_fulfilled_count: 1,
			supplier_fulfilled_count: 0,
			local_stock_remaining_summary: "SuperGrok 3个月 2",
			supplier_item_count: 0,
			manual_item_count: 1,
			supplier_pending_count: 0,
			supplier_failed_count: 0,
			payment_channel: "支付宝",
			payment_amount_minor: "4167",
			payment_currency: "CNY",
			payment_currency_decimals: 2,
			wallet_balance_after_minor: null,
			internal_supply_count: 1,
			downstream_order_no: "DJ-INTERNAL-1",
		},
		{
			amountMinor: "50000",
			currency: "CNY",
			currencyDecimals: 2,
			fresh: false,
		},
	);
	expect(text).toContain("用户实际支付：¥41.67");
	expect(text).toContain("手续费：¥1.67（用户承担）");
	expect(text).toContain("CDK来源：内置库存");
	expect(text).toContain("💰 老实人VIP内部供货单");
	expect(text).toContain("关联子站订单：DJ-INTERNAL-1");
	expect(text).toContain("VIP供货层利润：¥7.00");
	expect(text).toContain("请勿重复相加");
	expect(text).toContain("采购钱包剩余额度：¥500.00（缓存）");
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
