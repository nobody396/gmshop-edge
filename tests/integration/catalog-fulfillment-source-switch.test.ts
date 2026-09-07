import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { switchStockFulfillmentMode } from "#/features/catalog/server/fulfillment-source";
import { applyMigrations } from "./migrations";

describe("catalog stock fulfillment source switch", () => {
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
		await seed(db);
	});

	afterEach(async () => miniflare.dispose());

	it("requires staged inventory, then switches locally without deleting the supplier binding", async () => {
		await expect(
			switchStockFulfillmentMode(db, "item", "local", 1_000_000),
		).rejects.toMatchObject({ code: "local_inventory_empty", status: 409 });
		await db
			.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version,
				  content_fingerprint, content_mask, status, created_at, updated_at)
				 VALUES ('stock', 'item', 'ciphertext', 1, 'fingerprint', '••••1234',
				  'available', 1, 1)`,
			)
			.run();

		await expect(
			switchStockFulfillmentMode(db, "item", "local", 1_000_000),
		).resolves.toEqual({ id: "item", mode: "local", duplicate: false });
		await expect(state(db)).resolves.toMatchObject({
			fulfillment_source: "local",
			supplier_status: null,
			binding_enabled: 1,
		});
	});

	it("restores only a fresh, stocked, cost-bounded supplier", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version,
				  content_fingerprint, content_mask, status, created_at, updated_at)
				 VALUES ('stock', 'item', 'ciphertext', 1, 'fingerprint', '••••1234',
				  'available', 1, 1)`,
			),
			db.prepare(
				"UPDATE product_sellable_items SET fulfillment_source = 'local', supplier_status = NULL WHERE id = 'item'",
			),
		]);
		await db
			.prepare(
				"UPDATE supplier_bindings SET stock_quantity = 0 WHERE id = 'binding'",
			)
			.run();
		await expect(
			switchStockFulfillmentMode(db, "item", "supplier", 1_000_000),
		).rejects.toMatchObject({ code: "supplier_not_ready", status: 409 });

		await db
			.prepare(
				"UPDATE supplier_bindings SET stock_quantity = 2, last_synced_at = ? WHERE id = 'binding'",
			)
			.bind(1_000_000)
			.run();
		await expect(
			switchStockFulfillmentMode(db, "item", "supplier", 1_000_000),
		).resolves.toEqual({ id: "item", mode: "supplier", duplicate: false });
		await expect(state(db)).resolves.toMatchObject({
			fulfillment_source: "supplier",
			supplier_status: "available",
			binding_enabled: 1,
		});
	});
});

async function state(db: D1Database) {
	return db
		.prepare(
			`SELECT item.fulfillment_source, item.supplier_status,
			 binding.enabled AS binding_enabled
			 FROM product_sellable_items item
			 JOIN supplier_bindings binding ON binding.sellable_item_id = item.id
			 WHERE item.id = 'item'`,
		)
		.first();
}

async function seed(db: D1Database) {
	await db.batch([
		db.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, created_at, updated_at)
			 VALUES ('product', 'Product', 'stock', 'active', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, supplier_status,
			  currency, currency_decimals, price_minor, cost_minor,
			  enabled, created_at, updated_at)
			 VALUES ('item', 'product', 'SKU', 'supplier', 'available',
			  'CNY', 2, '200', '100', 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version,
			  currency, currency_decimals, name, credentials_encrypted,
			  credentials_revision, credential_fingerprint, balance_minor,
			  health_status, enabled, created_at, updated_at)
			 VALUES ('account', 'shared_stock', 'https://supplier.example',
			  'https://supplier.example', '1', 'CNY', 2, 'Supplier', 'encrypted',
			  1, 'fingerprint-account', '10000', 'healthy', 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO supplier_bindings
			 (id, sellable_item_id, provider, normalized_api_origin,
			  protocol_version, upstream_product_id, upstream_sku_id,
			  upstream_product_name, upstream_sku_name, reference_cost_minor,
			  max_cost_minor, stock_quantity, remote_status, last_synced_at,
			  enabled, created_at, updated_at)
			 VALUES ('binding', 'item', 'shared_stock', 'https://supplier.example',
			  '1', 'product', 'sku', 'Product', 'SKU', '100', '100', 2,
			  'active', 1000000, 1, 1, 1)`,
		),
	]);
}
