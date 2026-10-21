import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordOrderAttribution } from "#/features/attribution/server/order-attribution";
import {
	handleAttributionReportRequest,
	loadAttributionReport,
} from "#/features/attribution/server/report";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { applyMigrations } from "./migrations";

// 2026-10-21 12:00 Beijing.
const now = Date.UTC(2026, 9, 21, 4, 0, 0);
const hour = 3_600_000;

function cookieRequest(touch?: object) {
	return new Request("https://laoshirenvip.com/_serverFn/checkout", {
		method: "POST",
		headers: touch
			? {
					cookie: `PARAGLIDE_LOCALE=zh-CN; gmshop_ft=${encodeURIComponent(JSON.stringify(touch))}`,
				}
			: {},
	});
}

describe("order attribution", { timeout: 30_000 }, () => {
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
		const orders: Array<[string, string, string, number]> = [
			["search-paid", "completed", "4000", now - hour],
			["ai-paid", "paid", "12000", now - 2 * hour],
			["ai-pending", "pending_payment", "5000", now - 3 * hour],
			// 2026-10-20 23:30 Beijing — previous Beijing day.
			["direct-yesterday", "completed", "1000", Date.UTC(2026, 9, 20, 15, 30)],
			["legacy", "completed", "700", now - 4 * hour],
			["old", "completed", "999", now - 40 * 24 * hour],
		];
		await db.batch(
			orders.map(([id, status, total, createdAt]) =>
				db
					.prepare(
						`INSERT INTO shop_orders
						 (id, order_number, status, currency, currency_decimals,
						  subtotal_minor, total_minor, expires_at, created_at, updated_at)
						 VALUES (?, ?, ?, 'CNY', 2, ?, ?, 1, ?, ?)`,
					)
					.bind(id, `GM${id}`, status, total, total, createdAt, createdAt),
			),
		);
	});

	afterEach(async () => miniflare.dispose());

	it("stores the first touch once per order and classifies it", async () => {
		await recordOrderAttribution(
			db,
			"search-paid",
			cookieRequest({ v: 1, r: "www.baidu.com", p: "/products/a", t: 10 }),
		);
		await recordOrderAttribution(
			db,
			"search-paid",
			cookieRequest({ v: 1, r: "chatgpt.com", p: "/", t: 11 }),
		);
		await recordOrderAttribution(
			db,
			"ai-paid",
			cookieRequest({
				v: 1,
				s: "chatgpt.com",
				m: "referral",
				c: "launch",
				p: "/",
				t: 12,
			}),
		);
		await recordOrderAttribution(
			db,
			"ai-pending",
			cookieRequest({ v: 1, r: "kimi.moonshot.cn", p: "/", t: 13 }),
		);
		await recordOrderAttribution(
			db,
			"direct-yesterday",
			cookieRequest({ v: 1, p: "/guides/apple-id-login", t: 14 }),
		);
		const rows = await db
			.prepare(
				"SELECT order_id, source_category, referrer_host, utm_source, utm_campaign, landing_path, first_seen_at FROM order_attribution ORDER BY order_id",
			)
			.all();
		expect(rows.results).toEqual([
			{
				order_id: "ai-paid",
				source_category: "ai",
				referrer_host: null,
				utm_source: "chatgpt.com",
				utm_campaign: "launch",
				landing_path: "/",
				first_seen_at: 12,
			},
			expect.objectContaining({
				order_id: "ai-pending",
				source_category: "ai",
			}),
			expect.objectContaining({
				order_id: "direct-yesterday",
				source_category: "direct",
				landing_path: "/guides/apple-id-login",
			}),
			expect.objectContaining({
				order_id: "search-paid",
				source_category: "search",
				referrer_host: "www.baidu.com",
			}),
		]);

		await recordOrderAttribution(db, "legacy", cookieRequest());
		const legacy = await db
			.prepare(
				"SELECT source_category FROM order_attribution WHERE order_id = 'legacy'",
			)
			.first();
		expect(legacy).toEqual({ source_category: "unknown" });
	});

	it("reports orders and paid amounts per Beijing day and source", async () => {
		await recordOrderAttribution(
			db,
			"search-paid",
			cookieRequest({ v: 1, r: "www.baidu.com", p: "/" }),
		);
		await recordOrderAttribution(
			db,
			"ai-paid",
			cookieRequest({ v: 1, r: "chatgpt.com", p: "/" }),
		);
		await recordOrderAttribution(
			db,
			"ai-pending",
			cookieRequest({ v: 1, r: "chatgpt.com", p: "/" }),
		);
		await recordOrderAttribution(
			db,
			"direct-yesterday",
			cookieRequest({ v: 1, p: "/" }),
		);
		const report = await loadAttributionReport(db, 7, now);
		expect(report.rows).toEqual([
			{
				date: "2026-10-21",
				category: "ai",
				currency: "CNY",
				orders: 2,
				paidOrders: 1,
				paidAmountMinor: "12000",
			},
			{
				date: "2026-10-21",
				category: "search",
				currency: "CNY",
				orders: 1,
				paidOrders: 1,
				paidAmountMinor: "4000",
			},
			{
				date: "2026-10-21",
				category: "unattributed",
				currency: "CNY",
				orders: 1,
				paidOrders: 1,
				paidAmountMinor: "700",
			},
			{
				date: "2026-10-20",
				category: "direct",
				currency: "CNY",
				orders: 1,
				paidOrders: 1,
				paidAmountMinor: "1000",
			},
		]);
		expect(report.totals[0]).toMatchObject({
			category: "ai",
			paidAmountMinor: "12000",
		});
		expect((await loadAttributionReport(db, 1, now)).rows).toHaveLength(3);
	});

	it("requires the ops token", async () => {
		const env = {
			DB: db,
			RESTOCK_API_TOKEN: "ops-token",
		} as CloudflareBindings;
		const denied = await handleAttributionReportRequest(
			new Request("https://laoshirenvip.com/api/ops/attribution?days=7"),
			env,
		);
		expect(denied.status).toBe(401);
		const allowed = await handleAttributionReportRequest(
			new Request("https://laoshirenvip.com/api/ops/attribution?days=7", {
				headers: { authorization: "Bearer ops-token" },
			}),
			env,
		);
		expect(allowed.status).toBe(200);
		await expect(allowed.json()).resolves.toMatchObject({
			ok: true,
			days: 7,
			timezone: "Asia/Shanghai",
		});
		const invalid = await handleAttributionReportRequest(
			new Request("https://laoshirenvip.com/api/ops/attribution?days=0", {
				headers: { authorization: "Bearer ops-token" },
			}),
			env,
		);
		expect(invalid.status).toBe(400);
	});
});
