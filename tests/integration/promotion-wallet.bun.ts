import { expect, it } from "bun:test";
import { reserveOrderBalance } from "#/features/promotions/server/balance";
import { requestShopRefund } from "#/features/shop-payments/server/refunds";
import { completeFreeStoreOrder } from "#/features/shop-payments/server/service";
import { getWallet } from "#/features/wallet/server/ledger";
import { openNodeDatabase } from "#/server/runtime/node/database";
import { applyNodeMigrations } from "#/server/runtime/node/migrations";

it("keeps SQLite split balance payment and refund behavior aligned with D1", async () => {
	const raw = openNodeDatabase(":memory:");
	try {
		await applyNodeMigrations(raw);
		const db = raw as unknown as D1Database;
		const user = "11111111-1111-4111-8111-111111111111",
			order = "22222222-2222-4222-8222-222222222222";
		await db.batch([
			db
				.prepare(`INSERT INTO users(id,name,email,email_verified,enabled,balance_minor,reward_balance_minor,created_at,updated_at)
    VALUES(?,'Test','local@example.com',1,1,'200','800',1,1)`)
				.bind(user),
			db
				.prepare(`INSERT INTO shop_orders(id,order_number,user_id,status,currency,currency_decimals,subtotal_minor,discount_minor,total_minor,paid_minor,expires_at,created_at,updated_at)
    VALUES(?,'LOCAL-SQLITE',?,'pending_payment','CNY',2,'1000','0','1000','0',?,1,1)`)
				.bind(order, user, Date.now() + 60000),
		]);
		expect(await reserveOrderBalance(db, order, user)).toMatchObject({
			cash_minor: "200",
			reward_minor: "800",
			external_minor: "0",
		});
		await completeFreeStoreOrder(db, order, user);
		const refund = await requestShopRefund(
			db,
			{
				orderId: order,
				amountMinor: "1000",
				idempotencyKey: "sqlite-refund-test",
				reason: "Local test",
			},
			{
				actorUserId: user,
				request: new Request("https://shop.example.com/admin/orders"),
			},
		);
		expect(refund.status).toBe("succeeded");
		expect(await getWallet(db, user)).toMatchObject({
			balanceMinor: "200",
			rewardBalanceMinor: "800",
		});
		const plan = await db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT order_id FROM promotion_rewards WHERE user_id=? ORDER BY created_at,order_id",
			)
			.bind(user)
			.all<{ detail: string }>();
		expect(
			plan.results.some((row) =>
				row.detail.includes("promotion_rewards_user_created_idx"),
			),
		).toBe(true);
		expect(
			(await db.prepare("PRAGMA foreign_key_check").all()).results,
		).toEqual([]);
	} finally {
		raw.sqlite.close();
	}
});
