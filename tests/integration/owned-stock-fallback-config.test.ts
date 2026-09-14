import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "./migrations";

const targets = [
	[
		"11111111-1111-4111-8111-111111111111",
		"Claude Pro 1个月",
		"44444444-4444-4444-8444-444444444444",
		"fixture-claude",
	],
	[
		"22222222-2222-4222-8222-222222222222",
		"ChatGPT Go 1个月",
		"55555555-5555-4555-8555-555555555555",
		"fixture-go",
	],
	[
		"33333333-3333-4333-8333-333333333333",
		"ChatGPT Pro 20X 菲区续费1个月",
		"66666666-6666-4666-8666-666666666666",
		"fixture-renewal",
	],
] as const;

describe("owned-stock fallback activation gates", { timeout: 30_000 }, () => {
	let mf: Miniflare, db: D1Database;
	beforeEach(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO products(id,name,product_type,status) VALUES ('product','Memberships','stock','active')",
			)
			.run();
		for (const [id, name, binding, sku] of targets)
			await db.batch([
				db
					.prepare(
						"INSERT INTO product_sellable_items(id,product_id,name,fulfillment_source,price_minor) VALUES (?,'product',?,'local','200')",
					)
					.bind(id, name),
				db
					.prepare(`INSERT INTO supplier_bindings(id,sellable_item_id,provider,normalized_api_origin,protocol_version,upstream_product_id,upstream_sku_id,upstream_product_name,upstream_sku_name,reference_cost_minor,max_cost_minor,stock_quantity,remote_status,last_synced_at,enabled)
    VALUES (?,?,'shared_stock','https://supplier.example','acg-sharedstock-v1',?,?,'Product','SKU','100','100',10,'active',?,1)`)
					.bind(binding, id, sku, sku, Date.now()),
			]);
	});
	afterEach(async () => mf.dispose());
	async function activate() {
		const sql = await readFile(
			new URL("../fixtures/owned-stock-mode-config.sql", import.meta.url),
			"utf8",
		);
		return db.batch(
			sql.split("--> statement-breakpoint").map((s) => db.prepare(s.trim())),
		);
	}
	it("enables only renewal fallback and leaves Claude Pro / Go as manual modes", async () => {
		await activate();
		await activate();
		expect(
			(
				await db
					.prepare("SELECT key,value FROM system_settings ORDER BY key")
					.all()
			).results,
		).toEqual(
			targets
				.map(([id]) => ({
					key: `fulfillment.supplier_fallback.${id}`,
					value: id === targets[2][0] ? "true" : "false",
				}))
				.sort((a, b) => a.key.localeCompare(b.key)),
		);
		const renewal = await db
			.prepare(
				"SELECT policy_json,price_minor FROM product_sellable_items WHERE id=?",
			)
			.bind(targets[2][0])
			.first<{ policy_json: string; price_minor: string }>();
		expect(renewal?.price_minor).toBe("200");
		expect(
			JSON.parse(renewal?.policy_json ?? "{}").supplierUsageGuide,
		).toMatchObject({
			skuId: "fixture-renewal",
			url: "https://redeem.example/",
		});
	});
	it("keeps an existing Claude/Go supplier selection and configures only renewal local-first", async () => {
		await db
			.prepare(
				"UPDATE product_sellable_items SET fulfillment_source='supplier',supplier_status='available'",
			)
			.run();
		await activate();
		for (const [id] of targets)
			expect(
				await db
					.prepare(
						"SELECT fulfillment_source FROM product_sellable_items WHERE id=?",
					)
					.bind(id)
					.first(),
			).toEqual({
				fulfillment_source: id === targets[2][0] ? "local" : "supplier",
			});
	});

	it.each([
		"wrong-sku",
		"stale",
		"wrong-origin",
		"disabled",
		"over-price",
	])("rejects %s before enabling anything", async (mode) => {
		const update = {
			"wrong-sku": "upstream_sku_id='different-tier'",
			stale: "last_synced_at=1",
			"wrong-origin": "normalized_api_origin='https://other.example'",
			disabled: "enabled=0",
			"over-price": "reference_cost_minor='101'",
		}[mode];
		await db
			.prepare(`UPDATE supplier_bindings SET ${update} WHERE id=?`)
			.bind(targets[0][2])
			.run();
		await expect(activate()).rejects.toThrow();
		expect(
			(await db.prepare("SELECT key FROM system_settings").all()).results,
		).toHaveLength(0);
	});
	it("retires only unsold renewal manual vouchers, preserving owned codes and real AISOU stock", async () => {
		for (const [id, item, source, status] of [
			["claude", targets[0][0], "redeem-warehouse", "available"],
			["go", targets[1][0], "86", "available"],
			[
				"renew-voucher",
				targets[2][0],
				"owner-generated-manual-voucher",
				"available",
			],
			[
				"renew-delivered",
				targets[2][0],
				"owner-generated-manual-voucher",
				"delivered",
			],
			["renew-aisou", targets[2][0], "aisou", "available"],
		])
			await db
				.prepare(`INSERT INTO stock_entries(id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status,procurement_source)
   VALUES (?,?,'encrypted',1,?,'masked',?,?)`)
				.bind(id, item, id, status, source)
				.run();
		await activate();
		await activate();
		expect(
			(
				await db
					.prepare("SELECT id,status FROM stock_entries ORDER BY id")
					.all()
			).results,
		).toEqual([
			{ id: "claude", status: "available" },
			{ id: "go", status: "available" },
			{ id: "renew-aisou", status: "available" },
			{ id: "renew-delivered", status: "delivered" },
			{ id: "renew-voucher", status: "disabled" },
		]);
	});
});
