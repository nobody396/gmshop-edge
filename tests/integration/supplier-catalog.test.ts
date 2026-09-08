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
