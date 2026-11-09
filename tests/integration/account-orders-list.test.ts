import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	accountOrderSummary,
	listStoreAccountOrders,
} from "#/features/storefront/server/account-orders";
import { applyMigrations } from "./migrations";

describe("account order list", { timeout: 30_000 }, () => {
	let mf: Miniflare, db: D1Database;
	beforeAll(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: "account-orders-list" },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			db.prepare(
				`INSERT INTO users(id,name,email) VALUES
				 ('u1','Buyer','buyer@example.com'),('u2','Other','other@example.com')`,
			),
			db.prepare(
				`INSERT INTO products(id,name,product_type,status,cover_object_key,updated_at) VALUES
				 ('p-cover','ChatGPT Plus','stock','active','covers/p.png',1700),
				 ('p-plain','Gmail','stock','active',NULL,1800)`,
			),
			db.prepare(
				`INSERT INTO shop_orders(id,order_number,user_id,status,currency,currency_decimals,
				 subtotal_minor,total_minor,expires_at,created_at,updated_at) VALUES
				 ('o-multi','GM-MULTI-0001','u1','completed','CNY',2,'300','300',0,3000,3000),
				 ('o-single','GM-SINGLE-0001','u1','pending','CNY',2,'100','100',0,2000,2000),
				 ('o-empty','GM-EMPTY-0001','u1','cancelled','CNY',2,'0','0',0,1000,1000),
				 ('o-other','GM-OTHER-0001','u2','completed','CNY',2,'100','100',0,4000,4000)`,
			),
			db.prepare(
				`INSERT INTO shop_order_items(id,order_id,product_id,sellable_item_id,product_name,
				 delivery_component_id,delivery_component_type,delivery_component_version,
				 sellable_item_name,quantity,unit_price_minor,subtotal_minor,created_at) VALUES
				 ('i-b','o-multi','p-plain','s-b','Gmail','d','stock',1,'US fresh',1,'100','100',20),
				 ('i-a','o-multi','p-cover','s-a','ChatGPT Plus','d','stock',1,'1 month',2,'100','200',10),
				 ('i-c','o-single','p-plain','s-b','Gmail','d','stock',1,'Gmail',1,'100','100',10),
				 ('i-d','o-other','p-cover','s-a','ChatGPT Plus','d','stock',1,'1 month',1,'100','100',10)`,
			),
		]);
	});
	afterAll(async () => {
		await mf.dispose();
	});

	it("summarises each of the customer's orders by its first item", async () => {
		const { results } = await listStoreAccountOrders(db, "u1");
		expect(results.map(accountOrderSummary)).toEqual([
			{
				orderNumber: "GM-MULTI-0001",
				status: "completed",
				currency: "CNY",
				currencyDecimals: 2,
				totalMinor: "300",
				productName: "ChatGPT Plus",
				sellableItemName: "1 month",
				coverUrl: "/api/shop/products/p-cover/cover?v=1700",
				itemCount: 2,
				createdAt: 3000,
				updatedAt: 3000,
			},
			expect.objectContaining({
				orderNumber: "GM-SINGLE-0001",
				productName: "Gmail",
				sellableItemName: "Gmail",
				coverUrl: null,
				itemCount: 1,
			}),
			expect.objectContaining({
				orderNumber: "GM-EMPTY-0001",
				productName: null,
				sellableItemName: null,
				coverUrl: null,
				itemCount: 0,
			}),
		]);
	});

	it("never lists another customer's orders", async () => {
		const { results } = await listStoreAccountOrders(db, "u2");
		expect(results.map((order) => order.order_number)).toEqual([
			"GM-OTHER-0001",
		]);
	});
});
