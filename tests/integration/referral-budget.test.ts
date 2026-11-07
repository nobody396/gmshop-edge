import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { refreshReferralBudgets } from "#/features/promotions/server/referral-budget";
import { applyMigrations } from "./migrations";

describe("refreshReferralBudgets", { timeout: 30000 }, () => {
	let mf: Miniflare, db: D1Database;
	beforeEach(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		const sku = (
			id: string,
			price: string,
			cost: string | null,
			tier: string,
		) =>
			db
				.prepare(
					`INSERT INTO product_sellable_items(id,product_id,name,price_minor,cost_minor,currency,currency_decimals,promotion_budget_minor,created_at,updated_at)
					 VALUES (?,'p',?,?,?,'CNY',2,?,1,1)`,
				)
				.bind(id, id, price, cost, tier);
		const channelPrice = (item: string, channel: string, price: string) =>
			db
				.prepare(
					`INSERT INTO sellable_item_channel_prices(id,sellable_item_id,channel_id,price_minor,enabled,created_at,updated_at)
					 VALUES (?,?,?,?,1,1,1)`,
				)
				.bind(crypto.randomUUID(), item, channel, price);
		await db.batch([
			db.prepare(
				`INSERT INTO products(id,name,product_type,status,created_at,updated_at) VALUES ('p','P','stock','active',1,1)`,
			),
			db.prepare(
				`INSERT INTO payment_channels(id,provider,name,currency,fee_bps,enabled,created_at,updated_at) VALUES
				 ('usdt','gmpay','USDT','CNY',0,1,1,1),('alipay','epay','支付宝','CNY',160,1,1,1)`,
			),
			sku("ios", "137000", "125000", "800"),
			sku("new", "108000", "102000", "800"),
			sku("renew", "108000", "100000", "800"),
			sku("off", "50000", "10000", "0"),
			sku("nocost", "50000", null, "400"),
			channelPrice("ios", "usdt", "137000"),
			channelPrice("ios", "alipay", "140000"),
			channelPrice("new", "alipay", "111000"),
			channelPrice("renew", "alipay", "111000"),
			db.prepare(
				`INSERT INTO system_settings(key,value,is_secret,created_at,updated_at) VALUES
				 ('pricing.cost_factors','{"86":1.0031,"xiaojiu":1.0007,"aisou":0.9927,"buffer":1.01}',0,1,1),
				 ('pricing.equal_price_groups','[["new","renew"]]',0,1,1)`,
			),
		]);
	});
	afterEach(async () => {
		await mf.dispose();
	});
	const budgets = async () =>
		Object.fromEntries(
			(
				await db
					.prepare(
						"SELECT id, referral_budget_minor FROM product_sellable_items ORDER BY id",
					)
					.all<{ id: string; referral_budget_minor: string }>()
			).results.map((row) => [row.id, row.referral_budget_minor]),
		);

	it("writes 35% of the thinnest margin and is idempotent", async () => {
		expect(await refreshReferralBudgets(db)).toEqual({
			status: "ok",
			changed: 3,
		});
		// iOS: 1370 − 1250×1.0031×1.01 ≈ 103.6 → ×35% = 36.2 → ¥36.
		// New/renew share the lower: new 1080 − 1020×1.0131 ≈ 46.6 → ¥16.
		expect(await budgets()).toEqual({
			ios: "3600",
			new: "1600",
			nocost: "0",
			off: "0",
			renew: "1600",
		});
		expect(await refreshReferralBudgets(db)).toEqual({
			status: "ok",
			changed: 0,
		});
	});

	it("follows a price drop and leaves the SKU out once it stops participating", async () => {
		await refreshReferralBudgets(db);
		await db.batch([
			db.prepare(
				"UPDATE sellable_item_channel_prices SET price_minor='130000' WHERE sellable_item_id='ios' AND channel_id='usdt'",
			),
			db.prepare(
				"UPDATE product_sellable_items SET promotion_budget_minor='0' WHERE id='new'",
			),
		]);
		await refreshReferralBudgets(db);
		const after = await budgets();
		// 1300 − 1266.4 ≈ 33.6 → ¥11.
		expect(after.ios).toBe("1100");
		expect(after.new).toBe("0");
		expect(after.renew).toBe("0");
	});
});
