import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storefrontStockExpression } from "#/features/storefront/server/stock-availability";
import { applyMigrations } from "./migrations";

describe("storefront manual procurement stock", { timeout: 30_000 }, () => {
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
		await db.batch([
			db.prepare(
				`INSERT INTO products
				 (id, name, product_type, status, created_at, updated_at)
				 VALUES ('manual-product', 'Manual product', 'stock', 'active', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, fulfillment_source, supplier_status,
				  currency, currency_decimals, price_minor, created_at, updated_at)
				 VALUES ('manual-item', 'manual-product', 'Manual SKU', 'manual', NULL,
				  'CNY', 2, '1000', 1, 1)`,
			),
		]);
	});

	afterEach(async () => miniflare.dispose());

	it("keeps multi-source manual procurement available independently of one binding", async () => {
		await expect(stock()).resolves.toBe(-1);
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					`INSERT INTO supplier_accounts
				 (id, provider, base_url, normalized_api_origin, protocol_version,
				  name, credentials_encrypted, credential_fingerprint, balance_minor,
				  health_status, enabled, created_at, updated_at)
				 VALUES ('manual-account', 'shared_stock', 'https://supplier.example',
				  'https://supplier.example', 'acg-sharedstock-v1', 'Manual supplier',
				  'encrypted', 'fingerprint', '10000', 'healthy', 1, ?, ?)`,
				)
				.bind(now, now),
			db
				.prepare(
					`INSERT INTO supplier_bindings
				 (id, sellable_item_id, provider, normalized_api_origin,
				  protocol_version, upstream_product_id, upstream_sku_id,
				  upstream_product_name, upstream_sku_name, reference_cost_minor,
				  max_cost_minor, stock_quantity, remote_status, last_synced_at,
				  enabled, created_at, updated_at)
				 VALUES ('manual-binding', 'manual-item', 'shared_stock',
				  'https://supplier.example', 'acg-sharedstock-v1', 'product', 'sku',
				  'Product', 'SKU', '500', '600', 7, 'active', ?, 1, ?, ?)`,
				)
				.bind(now, now, now),
		]);
		await expect(stock()).resolves.toBe(-1);
		await db
			.prepare(
				"UPDATE supplier_bindings SET stock_quantity = 0 WHERE id = 'manual-binding'",
			)
			.run();
		await expect(stock()).resolves.toBe(-1);
	});

	async function stock() {
		const row = await db
			.prepare(
				`SELECT ${storefrontStockExpression("product", "item")} AS stock
				 FROM products product
				 JOIN product_sellable_items item ON item.product_id = product.id
				 WHERE item.id = 'manual-item'`,
			)
			.first<{ stock: number }>();
		return Number(row?.stock);
	}
});
