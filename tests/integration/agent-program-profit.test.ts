import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleOrderProfitRequest } from "#/features/agent-program/server/order-profit";
import { applyMigrations } from "./migrations";

const token = "synthetic-profit-token";
describe("read-only agent profit API", () => {
	let mf: Miniflare;
	let db: D1Database;
	beforeAll(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			db.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled) VALUES ('u','Buyer','buyer@example.test',1,1),('other','Other','other@example.test',1,1)",
			),
			db.prepare(
				"INSERT INTO supplier_api_keys(id,user_id,name,key_id,secret_encrypted) VALUES ('key','u','Test','test','not-a-real-secret')",
			),
			db.prepare(
				"INSERT INTO products(id,name,product_type,status) VALUES ('p','Product','stock','active')",
			),
			db.prepare(
				"INSERT INTO product_sellable_items(id,product_id,name,currency,currency_decimals,price_minor) VALUES ('sku','p','Item','CNY',2,'11000')",
			),
		]);
	}, 30000);
	afterAll(async () => mf.dispose());
	async function order(
		id: string,
		no: string,
		cost: string | null,
		quantity = 1,
		source?: string,
		user = "u",
	) {
		await db.batch([
			db
				.prepare(
					"INSERT INTO shop_orders(id,order_number,user_id,currency,currency_decimals,subtotal_minor,total_minor,paid_minor,expires_at) VALUES (?,?,?,'CNY',2,'12000','12000','11000',1)",
				)
				.bind(id, id, user),
			db
				.prepare(
					"INSERT INTO shop_order_items(id,order_id,product_id,sellable_item_id,product_name,delivery_component_id,delivery_component_type,delivery_component_version,sellable_item_name,quantity,unit_price_minor,unit_cost_minor,subtotal_minor) VALUES (?,?,'p','sku','Product','sku','stock',1,'Item',?,'12000',?,'12000')",
				)
				.bind(`item-${id}`, id, quantity, cost),
			db
				.prepare(
					"INSERT INTO supplier_api_orders(id,shop_order_id,user_id,api_key_id,downstream_order_no,request_digest) VALUES (?,?,?,'key',?,'test')",
				)
				.bind(`api-${id}`, id, user, no),
		]);
		if (source)
			await db
				.prepare(
					"INSERT INTO stock_entries(id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status,order_item_id,procurement_source) VALUES (?,'sku','test',1,?,'test','delivered',?,?)",
				)
				.bind(`stock-${id}`, id, `item-${id}`, source)
				.run();
	}
	function request(nos: unknown, secret: string | undefined = token) {
		return handleOrderProfitRequest(
			new Request("https://shop.test/api/internal/agent-program/order-profit", {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify({ downstream_order_nos: nos }),
			}),
			{ DB: db, AGENT_PROGRAM_PROFIT_TOKEN: secret },
		);
	}
	it("requires bearer authentication before reading D1, including when unset", async () => {
		for (const secret of [undefined, "", "wrong"]) {
			const response = await handleOrderProfitRequest(
				new Request(
					"https://shop.test/api/internal/agent-program/order-profit",
					{
						method: "POST",
						headers: { authorization: `Bearer ${token}` },
						body: "not-json",
					},
				),
				{ AGENT_PROGRAM_PROFIT_TOKEN: secret },
			);
			expect(response.status).toBe(401);
		}
	});
	it("calculates paid revenue minus ceil-per-unit true cost and quantity, without mutating orders", async () => {
		await order("known", "DJ-known", "5000", 2, "86");
		const before = await db
			.prepare("SELECT * FROM shop_orders WHERE id='known'")
			.first();
		const result = await request(["DJ-known"]);
		expect(result.status).toBe(200);
		expect(await result.json()).toEqual({
			ok: true,
			orders: [
				{
					downstream_order_no: "DJ-known",
					supplier_api_order_id: "api-known",
					shop_order_id: "known",
					revenue_minor: "11000",
					true_cost_minor: "10144",
					profit_minor: "856",
					cost_known: true,
				},
			],
		});
		expect(
			await db.prepare("SELECT * FROM shop_orders WHERE id='known'").first(),
		).toEqual(before);
		expect(result.headers.get("cache-control")).toBe("no-store");
	});
	it("uses configured factors, highest for unknown suppliers, and fixed 1.01 buffer", async () => {
		await db
			.prepare(
				"INSERT INTO system_settings(key,value) VALUES ('pricing.cost_factors',?)",
			)
			.bind(
				JSON.stringify({ "86": 0.9, xiaojiu: 1.1, aisou: 1.0, buffer: 1.9 }),
			)
			.run();
		await order("source", "DJ-source", "10000", 1, "xiaojiu");
		await order("fallback", "DJ-fallback", "10000");
		const response = await request(["DJ-source", "DJ-fallback"]);
		expect(await response.json()).toMatchObject({
			orders: [
				{ true_cost_minor: "11110", profit_minor: "-110", cost_known: true },
				{ true_cost_minor: "11110", profit_minor: "-110", cost_known: true },
			],
		});
	});
	it("resolves automatic supplier stock through its supplied snapshot, keeping unlinked stock conservative", async () => {
		await order("aisou", "DJ-aisou", "10000");
		await db.batch([
			db.prepare(
				`INSERT INTO system_settings(key,value) VALUES ('pricing.cost_factors','{"86":0.9,"xiaojiu":1.1,"aisou":1.0}')
				 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
			),
			db.prepare(
				`INSERT INTO supplier_bindings
				 (id,sellable_item_id,provider,normalized_api_origin,protocol_version,upstream_product_id,upstream_sku_id,upstream_product_name,upstream_sku_name,reference_cost_minor,max_cost_minor)
				 VALUES ('aisou-binding','sku','shared_stock','https://aisou.pro','acg-sharedstock-v1','p','sku','Product','Item','10000','10000')`,
			),
			db.prepare(
				`INSERT INTO delivery_records(id,order_item_id,delivery_type,request_key,status)
				 VALUES ('aisou-delivery','item-aisou','stock','initial:item-aisou','delivered')`,
			),
			db.prepare(
				`INSERT INTO supplier_orders(id,order_id,order_item_id,delivery_record_id,supplier_binding_id,quantity,currency,binding_snapshot_json,state)
				 VALUES ('aisou-supply','aisou','item-aisou','aisou-delivery','aisou-binding',1,'CNY','{"normalizedApiOrigin":"https://aisou.pro"}','supplied')`,
			),
			db.prepare(
				`INSERT INTO stock_entries(id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status,order_item_id,supplier_order_id)
				 VALUES ('aisou-stock','sku','test',1,'aisou-stock','test','reserved','item-aisou','aisou-supply')`,
			),
		]);
		// No procurement_source: this is the shape written by automatic fulfillment.
		expect(
			await db
				.prepare(
					"SELECT procurement_source FROM stock_entries WHERE id='aisou-stock'",
				)
				.first(),
		).toEqual({ procurement_source: null });
		expect(await (await request(["DJ-aisou"])).json()).toMatchObject({
			orders: [
				{
					supplier_api_order_id: "api-aisou",
					shop_order_id: "aisou",
					true_cost_minor: "10100",
					profit_minor: "900",
					cost_known: true,
				},
			],
		});
		await db.batch([
			db.prepare(
				"UPDATE shop_order_items SET quantity=2 WHERE id='item-aisou'",
			),
			db.prepare(
				`INSERT INTO stock_entries(id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status,order_item_id)
				 VALUES ('unlinked-stock','sku','test',1,'unlinked-stock','test','delivered','item-aisou')`,
			),
		]);
		expect(await (await request(["DJ-aisou"])).json()).toMatchObject({
			orders: [
				{ true_cost_minor: "22220", profit_minor: "-11220", cost_known: true },
			],
		});
	});
	it("flags null/zero/missing costs and unknown or ambiguous downstream numbers as zero profit", async () => {
		await order("null", "DJ-null", null);
		await order("zero", "DJ-zero", "0");
		await order("dup1", "DJ-duplicate", "100");
		await order("dup2", "DJ-duplicate", "100", 1, undefined, "other");
		const response = await request([
			"DJ-null",
			"DJ-zero",
			"DJ-missing",
			"DJ-duplicate",
		]);
		expect(await response.json()).toMatchObject({
			ok: true,
			orders: Array.from({ length: 4 }, () => ({
				profit_minor: "0",
				cost_known: false,
			})),
		});
	});
	it("validates the 500-order bound, deduplicates and honors D1 parameter limits", async () => {
		const response = await request(
			Array.from({ length: 500 }, (_, i) => `missing-${i}`),
		);
		expect(response.status).toBe(200);
		expect(
			((await response.json()) as { orders: unknown[] }).orders,
		).toHaveLength(500);
		expect(
			(await request(Array.from({ length: 501 }, (_, i) => `missing-${i}`)))
				.status,
		).toBe(400);
		expect((await request([])).status).toBe(200);
		for (const value of [["bad number"], [123]])
			expect((await request(value)).status).toBe(400);
		expect(
			(
				(await (await request(["same", "same"])).json()) as {
					orders: unknown[];
				}
			).orders,
		).toHaveLength(1);
	});
	it("bounds streamed bodies and redacts DB failures", async () => {
		const response = await handleOrderProfitRequest(
			new Request("https://shop.test/api/internal/agent-program/order-profit", {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: "x".repeat(40001),
			}),
			{ DB: db, AGENT_PROGRAM_PROFIT_TOKEN: token },
		);
		expect(response.status).toBe(413);
		const failDb = {
			prepare() {
				throw new Error(token);
			},
		} as unknown as D1Database;
		const failed = await handleOrderProfitRequest(
			new Request("https://shop.test/api/internal/agent-program/order-profit", {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify({ downstream_order_nos: ["a"] }),
			}),
			{ DB: failDb, AGENT_PROGRAM_PROFIT_TOKEN: token },
		);
		expect(failed.status).toBe(500);
		expect(await failed.text()).not.toContain(token);
	});
});
