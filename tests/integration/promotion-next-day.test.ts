import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { settlePromotionRewards } from "#/features/promotions/server/balance";
import { applyMigrations } from "./migrations";

it("migrates only pending deadlines and matures at Beijing calendar boundaries", {
	timeout: 30000,
}, async () => {
	const mf = new Miniflare({
		modules: true,
		script: "export default {fetch(){return new Response('ok')}}",
		d1Databases: { DB: crypto.randomUUID() },
	});
	try {
		const db = await mf.getD1Database("DB");
		await applyMigrations(db, "0029_promotion_wallet.sql");
		await db
			.prepare(
				"INSERT INTO users(id,name,email,enabled,balance_minor,reward_balance_minor,created_at,updated_at) VALUES('promoter','Fixture','clock@example.test',1,'123','456',1,1)",
			)
			.run();
		async function order(id: string, completed: number | null) {
			await db
				.prepare(`INSERT INTO shop_orders(id,order_number,status,currency,currency_decimals,subtotal_minor,discount_minor,total_minor,paid_minor,promotion_purpose,referrer_user_id,referral_reward_minor,created_at,updated_at,expires_at)
    VALUES(?,?,'pending_payment','CNY',2,'1000','0','1000','0','referral','promoter','100',1,1,2000000000000)`)
				.bind(id, id)
				.run();
			await db
				.prepare(
					"UPDATE shop_orders SET status='paid',paid_minor='1000' WHERE id=?",
				)
				.bind(id)
				.run();
			if (completed !== null)
				await db
					.prepare(
						"UPDATE shop_orders SET status='completed',updated_at=? WHERE id=?",
					)
					.bind(completed, id)
					.run();
		}
		const completion = Date.parse("2026-10-08T10:00:00Z"),
			midnight = Date.parse("2026-10-08T16:00:00Z");
		await order("pending", completion);
		await order("available", completion);
		await order("reversed", completion);
		await order("undelivered", null);
		await db
			.prepare(
				"UPDATE promotion_rewards SET updated_at=?,remaining_minor='50' WHERE order_id='pending'",
			)
			.bind(completion + 3 * 86400000)
			.run();
		await db
			.prepare(
				"UPDATE promotion_rewards SET state='available' WHERE order_id='available'",
			)
			.run();
		await db
			.prepare(
				"UPDATE promotion_rewards SET state='reversed' WHERE order_id='reversed'",
			)
			.run();
		const before = await db
			.prepare(
				"SELECT balance_minor,reward_balance_minor FROM users WHERE id='promoter'",
			)
			.first();
		const sql = await readFile(
			new URL(
				"../../drizzle/0030_promotion_next_beijing_day.sql",
				import.meta.url,
			),
			"utf8",
		);
		for (const statement of sql
			.split("--> statement-breakpoint")
			.map((s) => s.trim())
			.filter(Boolean))
			await db.prepare(statement).run();
		const rows = (
			await db
				.prepare(
					"SELECT order_id,available_at,state,remaining_minor FROM promotion_rewards ORDER BY order_id",
				)
				.all()
		).results;
		expect(rows).toEqual([
			{
				order_id: "available",
				available_at: completion + 604800000,
				state: "available",
				remaining_minor: "100",
			},
			{
				order_id: "pending",
				available_at: midnight,
				state: "pending",
				remaining_minor: "50",
			},
			{
				order_id: "reversed",
				available_at: completion + 604800000,
				state: "reversed",
				remaining_minor: "100",
			},
			{
				order_id: "undelivered",
				available_at: null,
				state: "pending",
				remaining_minor: "100",
			},
		]);
		expect(
			await db
				.prepare(
					"SELECT balance_minor,reward_balance_minor FROM users WHERE id='promoter'",
				)
				.first(),
		).toEqual(before);
		expect(await settlePromotionRewards(db, midnight - 1)).toEqual({
			settled: 0,
		});
		expect(await settlePromotionRewards(db, midnight)).toEqual({ settled: 1 });
		expect(await settlePromotionRewards(db, midnight + 1)).toEqual({
			settled: 0,
		});
		for (const [id, stamp, expected] of [
			["exact-midnight", "2026-10-08T16:00:00Z", "2026-10-09T16:00:00Z"],
			["before-midnight", "2026-10-08T15:59:59.999Z", "2026-10-08T16:00:00Z"],
			["year-boundary", "2026-12-31T15:59:59.999Z", "2026-12-31T16:00:00Z"],
			["month-boundary", "2026-10-31T01:00:00Z", "2026-10-31T16:00:00Z"],
		] as const) {
			await order(id, Date.parse(stamp));
			expect(
				await db
					.prepare(
						"SELECT available_at FROM promotion_rewards WHERE order_id=?",
					)
					.bind(id)
					.first("available_at"),
			).toBe(Date.parse(expected));
			await db
				.prepare(
					"UPDATE shop_orders SET updated_at=?,status='completed' WHERE id=?",
				)
				.bind(Date.parse(stamp) + 86400000, id)
				.run();
			expect(
				await db
					.prepare(
						"SELECT available_at FROM promotion_rewards WHERE order_id=?",
					)
					.bind(id)
					.first("available_at"),
			).toBe(Date.parse(expected));
		}
		expect(
			(await db.prepare("PRAGMA foreign_key_check").all()).results,
		).toEqual([]);
	} finally {
		await mf.dispose();
	}
});
