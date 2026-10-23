import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getSupplierProduct,
	listSupplierCatalog,
} from "#/features/supplier-api/server/catalog";
import { applyMigrations } from "./migrations";

describe("supplier catalog", () => {
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

	it("paginates products in D1 while retaining every SKU on the selected page", async () => {
		const first = await listSupplierCatalog(db, { page: 1, pageSize: 2 });
		expect(first.total).toBe(3);
		expect(first.items.map((product) => product.id)).toEqual([
			"product-1",
			"product-2",
		]);
		expect(first.items[0]?.skus.map((sku) => sku.id)).toEqual([
			"sku-1-a",
			"sku-1-b",
		]);
		expect(first.items[0]?.skus[0]?.cost_minor).toBe("90");
		expect(first.items[0]?.image_urls).toEqual([
			"/api/shop/products/product-1/cover",
		]);

		const second = await listSupplierCatalog(db, { page: 2, pageSize: 2 });
		expect(second.total).toBe(3);
		expect(second.items.map((product) => product.id)).toEqual(["product-3"]);
	});

	it("exports only explicitly enabled listings", async () => {
		await db
			.prepare(
				"UPDATE supplier_export_listings SET enabled = 0 WHERE sellable_item_id = 'sku-2-a'",
			)
			.run();
		const result = await listSupplierCatalog(db, { page: 1, pageSize: 10 });
		expect(result.total).toBe(2);
		expect(result.items.map((product) => product.id)).toEqual([
			"product-1",
			"product-3",
		]);
	});

	it("includes products whose central stock changed after the incremental cursor", async () => {
		await db
			.prepare(
				"UPDATE stock_entries SET updated_at = 10000 WHERE id = 'stock-1'",
			)
			.run();
		const result = await listSupplierCatalog(db, {
			page: 1,
			pageSize: 10,
			updatedAfter: new Date(9000).toISOString(),
		});
		expect(result.items.map((product) => product.id)).toEqual(["product-1"]);
	});

	it("reports supplier-funded stock changes to incremental syncs even when no row timestamp moved", async () => {
		await seedSupplierFunded(db, "2000");
		const t0 = Date.now();
		const full = await listSupplierCatalog(db, {
			page: 1,
			pageSize: 10,
			now: t0,
		});
		expect(
			full.items.find((product) => product.id === "product-4")?.skus[0],
		).toMatchObject({ stock_quantity: 20, active: true });

		const cursor = new Date(t0 + 1).toISOString();
		const unchanged = await listSupplierCatalog(db, {
			page: 1,
			pageSize: 10,
			updatedAfter: cursor,
			now: t0 + 2,
		});
		expect(unchanged.total).toBe(0);

		// Balance drained: the account row changes, the export rows do not.
		await db
			.prepare(
				"UPDATE supplier_accounts SET balance_minor = '0' WHERE id = 'account'",
			)
			.run();
		const drained = await listSupplierCatalog(db, {
			page: 1,
			pageSize: 10,
			updatedAfter: cursor,
			now: t0 + 3,
		});
		expect(drained.items.map((product) => product.id)).toEqual(["product-4"]);
		expect(drained.items[0]?.skus[0]).toMatchObject({
			stock_quantity: 0,
			active: false,
		});
		expect(drained.items[0]?.updated_at).toBe(new Date(t0 + 3).toISOString());

		// Owner tops up: stock comes back on the next incremental poll.
		const nextCursor = new Date(t0 + 4).toISOString();
		await db
			.prepare(
				"UPDATE supplier_accounts SET balance_minor = '20000' WHERE id = 'account'",
			)
			.run();
		const toppedUp = await listSupplierCatalog(db, {
			page: 1,
			pageSize: 10,
			updatedAfter: nextCursor,
			now: t0 + 5,
		});
		expect(toppedUp.items.map((product) => product.id)).toEqual(["product-4"]);
		expect(toppedUp.items[0]?.skus[0]).toMatchObject({
			stock_quantity: 50,
			active: true,
		});

		const quiet = await listSupplierCatalog(db, {
			page: 1,
			pageSize: 10,
			updatedAfter: new Date(t0 + 6).toISOString(),
			now: t0 + 7,
		});
		expect(quiet.total).toBe(0);
	});

	it("loads a product directly by ID independently of catalog page limits", async () => {
		await expect(getSupplierProduct(db, "product-3")).resolves.toMatchObject({
			product: { id: "product-3", skus: [{ id: "sku-3-a" }] },
		});
		await expect(getSupplierProduct(db, "missing")).rejects.toMatchObject({
			code: "supplier_product_not_found",
			status: 404,
		});
	});
});

async function seed(db: D1Database) {
	await db.batch([
		db.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, sort_order, cover_object_key, tag_names, created_at, updated_at)
			 VALUES
			 ('product-1', 'One', 'stock', 'active', 1, 'cover-1', '["first"]', 1, 1),
			 ('product-2', 'Two', 'stock', 'active', 2, NULL, '[]', 2, 2),
			 ('product-3', 'Three', 'stock', 'active', 3, NULL, '[]', 3, 3)`,
		),
		db.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, sort_order, fulfillment_source, currency,
			  currency_decimals, price_minor, created_at, updated_at)
			 VALUES
			 ('sku-1-a', 'product-1', 'A', 1, 'local', 'USD', 2, '100', 1, 1),
			 ('sku-1-b', 'product-1', 'B', 2, 'local', 'USD', 2, '200', 1, 1),
			 ('sku-2-a', 'product-2', 'A', 1, 'local', 'USD', 2, '300', 2, 2),
				 ('sku-3-a', 'product-3', 'A', 1, 'local', 'USD', 2, '400', 3, 3)`,
		),
		db.prepare(
			`INSERT INTO supplier_export_listings
			 (id, sellable_item_id, price_minor, currency, currency_decimals, enabled, created_at, updated_at)
			 VALUES
			 ('listing-1-a', 'sku-1-a', '90', 'USD', 2, 1, 1, 1),
			 ('listing-1-b', 'sku-1-b', '180', 'USD', 2, 1, 1, 1),
			 ('listing-2-a', 'sku-2-a', '270', 'USD', 2, 1, 2, 2),
			 ('listing-3-a', 'sku-3-a', '360', 'USD', 2, 1, 3, 3)`,
		),
		db.prepare(
			`INSERT INTO stock_entries
			 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint,
			  content_mask, status, created_at, updated_at)
			 VALUES
			 ('stock-1', 'sku-1-a', 'ciphertext', 1, 'fingerprint-1', '****', 'available', 1, 1),
			 ('stock-2', 'sku-3-a', 'ciphertext', 1, 'fingerprint-2', '****', 'available', 3, 3)`,
		),
	]);
}

async function seedSupplierFunded(db: D1Database, balanceMinor: string) {
	await db.batch([
		db.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, sort_order, tag_names, created_at, updated_at)
			 VALUES ('product-4', 'Four', 'stock', 'active', 4, '[]', 4, 4)`,
		),
		db.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, sort_order, fulfillment_source, currency,
			  currency_decimals, price_minor, supplier_status, created_at, updated_at)
			 VALUES ('sku-4-a', 'product-4', 'A', 1, 'supplier', 'USD', 2, '500', 'active', 4, 4)`,
		),
		db.prepare(
			`INSERT INTO supplier_export_listings
			 (id, sellable_item_id, price_minor, currency, currency_decimals, enabled, created_at, updated_at)
			 VALUES ('listing-4-a', 'sku-4-a', '450', 'USD', 2, 1, 4, 4)`,
		),
		db
			.prepare(
				`INSERT INTO supplier_accounts
				 (id, provider, base_url, normalized_api_origin, protocol_version, name,
				  credentials_encrypted, credential_fingerprint, balance_minor,
				  reserve_balance_minor, health_status, enabled, created_at, updated_at)
				 VALUES ('account', 'shared_stock', 'https://example.invalid',
				  'https://example.invalid', 'fixture', 'fixture', 'fixture', 'fixture',
				  ?, '0', 'healthy', 1, 4, 4)`,
			)
			.bind(balanceMinor),
		db
			.prepare(
				`INSERT INTO supplier_bindings
				 (id, sellable_item_id, provider, normalized_api_origin, protocol_version,
				  upstream_product_id, upstream_sku_id, upstream_product_name, upstream_sku_name,
				  reference_cost_minor, max_cost_minor, stock_quantity, remote_status,
				  last_synced_at, enabled, created_at, updated_at)
				 VALUES ('binding-4-a', 'sku-4-a', 'shared_stock', 'https://example.invalid',
				  'fixture', 'p', 'sku', 'P', 'SKU', '100', '100', 50, 'active', ?, 1, 4, 4)`,
			)
			.bind(Date.now()),
	]);
}
