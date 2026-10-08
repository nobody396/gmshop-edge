import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSupplierAvailability } from "#/features/storefront/server/multi-order";
import {
	storefrontCatalogStockExpression,
	storefrontStockExpression,
} from "#/features/storefront/server/stock-availability";
import { applyMigrations } from "./migrations";

describe("customer stock labels and product summaries", {
	timeout: 30_000,
}, () => {
	let mf: Miniflare, db: D1Database;
	beforeAll(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: "stock-labels" },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO products(id,name,product_type,status) VALUES ('p','Product','stock','active')",
			)
			.run();
		for (const [id, source] of [
			["owned", "local"],
			["a", "supplier"],
			["b", "supplier"],
		])
			await db
				.prepare(
					"INSERT INTO product_sellable_items(id,product_id,name,fulfillment_source,supplier_status,price_minor) VALUES (?,'p',?,?,?,'100')",
				)
				.bind(id, id, source, source === "supplier" ? "active" : null)
				.run();
		await db.batch(
			Array.from({ length: 100 }, (_, i) =>
				db
					.prepare(
						"INSERT INTO stock_entries(id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status) VALUES (?,'owned','fixture',1,?,'fixture','available')",
					)
					.bind(`stock-${i}`, `fp-${i}`),
			),
		);
		await db
			.prepare(
				"INSERT INTO supplier_accounts(id,provider,base_url,normalized_api_origin,protocol_version,name,credentials_encrypted,credential_fingerprint,balance_minor,reserve_balance_minor,health_status,enabled) VALUES ('account','shared_stock','https://example.invalid','https://example.invalid','fixture','fixture','fixture','fixture','100','0','healthy',1)",
			)
			.run();
		for (const [id, cost] of [
			["a", "10"],
			["b", "20"],
		])
			await db
				.prepare(
					"INSERT INTO supplier_bindings(id,sellable_item_id,provider,normalized_api_origin,protocol_version,upstream_product_id,upstream_sku_id,upstream_product_name,upstream_sku_name,reference_cost_minor,max_cost_minor,stock_quantity,remote_status,last_synced_at,enabled) VALUES (?,?,'shared_stock','https://example.invalid','fixture','p',?,'P','SKU',?,?,50,'active',?,1)",
				)
				.bind(id, id, id, cost, cost, Date.now())
				.run();
	});
	afterAll(async () => mf.dispose());
	async function summary(where = "1=1") {
		return (
			await db
				.prepare(
					`SELECT ${storefrontCatalogStockExpression("p", "i")} AS stock FROM product_sellable_items i JOIN products p ON p.id=i.product_id WHERE ${where}`,
				)
				.first<{ stock: number }>()
		)?.stock;
	}
	it("shows a numeric summary for supplier-only and mixed products without double counting the wallet", async () => {
		expect(await summary()).toBe(110);
		expect(await summary("i.fulfillment_source='supplier'")).toBe(10);
		expect(await summary("i.fulfillment_source='local'")).toBe(100);
		const sku = await db
			.prepare(
				`SELECT i.id,${storefrontStockExpression("p", "i")} AS stock FROM product_sellable_items i JOIN products p ON p.id=i.product_id ORDER BY i.id`,
			)
			.all();
		expect(sku.results).toEqual([
			{ id: "a", stock: 10 },
			{ id: "b", stock: 5 },
			{ id: "owned", stock: 100 },
		]);
	});
	it("zero verified supplier capacity displays zero, not a procurement marketing label", async () => {
		await db.prepare("UPDATE supplier_accounts SET balance_minor='0'").run();
		expect(await summary("i.fulfillment_source='supplier'")).toBe(0);
		expect(await summary()).toBe(100);
	});
	it("allows only opted-in SKUs to sell unfunded stock and preserves other guards", async () => {
		await db.prepare("UPDATE supplier_accounts SET balance_minor='0'").run();
		await db
			.prepare(
				"INSERT INTO system_settings(key,value) VALUES ('fulfillment.supplier_unfunded_checkout.b','true')",
			)
			.run();
		async function stock() {
			return (
				await db
					.prepare(
						`SELECT ${storefrontStockExpression("p", "i")} AS stock FROM product_sellable_items i JOIN products p ON p.id=i.product_id WHERE i.id='b'`,
					)
					.first<{ stock: number }>()
			)?.stock;
		}
		expect(await stock()).toBe(50);
		await expect(
			assertSupplierAvailability(db, "b", 1),
		).resolves.toBeUndefined();
		await expect(assertSupplierAvailability(db, "a", 1)).rejects.toMatchObject({
			code: "supplier_account_unavailable",
		});
		for (const change of [
			"UPDATE supplier_bindings SET stock_quantity=0 WHERE id='b'",
			"UPDATE supplier_bindings SET last_synced_at=1 WHERE id='b'",
			"UPDATE supplier_bindings SET remote_status='deleted' WHERE id='b'",
			"UPDATE supplier_bindings SET max_cost_minor='1' WHERE id='b'",
			"UPDATE supplier_bindings SET enabled=0 WHERE id='b'",
			"UPDATE supplier_accounts SET health_status='unavailable'",
			"UPDATE supplier_accounts SET enabled=0",
			"UPDATE supplier_accounts SET cooldown_until=9999999999999",
			"UPDATE supplier_accounts SET max_order_cost_minor='1'",
		]) {
			await db.prepare(change).run();
			expect(await stock(), change).toBe(0);
			await expect(assertSupplierAvailability(db, "b", 1)).rejects.toThrow();
			await db.batch([
				db
					.prepare(
						"UPDATE supplier_bindings SET stock_quantity=50,last_synced_at=?,remote_status='active',max_cost_minor='20',enabled=1 WHERE id='b'",
					)
					.bind(Date.now()),
				db.prepare(
					"UPDATE supplier_accounts SET health_status='healthy',enabled=1,cooldown_until=NULL,max_order_cost_minor=NULL",
				),
			]);
		}
		await db
			.prepare("UPDATE supplier_accounts SET max_order_cost_minor='40'")
			.run();
		expect(await stock()).toBe(2);
		await expect(assertSupplierAvailability(db, "b", 3)).rejects.toMatchObject({
			code: "supplier_account_unavailable",
		});
		await db
			.prepare(
				"UPDATE system_settings SET value='false' WHERE key='fulfillment.supplier_unfunded_checkout.b'",
			)
			.run();
		expect(await stock()).toBe(0);
		await expect(assertSupplierAvailability(db, "b", 1)).rejects.toMatchObject({
			code: "supplier_account_unavailable",
		});
	});
	it("uses only the stock label on public product cards and options", () => {
		for (const path of [
			"src/features/storefront/components/product-card.tsx",
			"src/features/storefront/pages/product.tsx",
		]) {
			const source = readFileSync(
				new URL(`../../${path}`, import.meta.url),
				"utf8",
			);
			expect(source).not.toMatch(/store_procurement|hasProcurement/);
			expect(source).toContain("m.store_stock(");
		}
		const catalog = readFileSync(
			new URL(
				"../../src/features/storefront/server/catalog.ts",
				import.meta.url,
			),
			"utf8",
		);
		expect(catalog).not.toContain("hasProcurement");
	});
});
