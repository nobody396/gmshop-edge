import { readFile } from "node:fs/promises";
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

function cookieRequest(touch?: object, last?: object) {
	const cookies = [
		"PARAGLIDE_LOCALE=zh-CN",
		...(touch
			? [`gmshop_ft=${encodeURIComponent(JSON.stringify(touch))}`]
			: []),
		...(last ? [`gmshop_lt=${encodeURIComponent(JSON.stringify(last))}`] : []),
	];
	return new Request("https://laoshirenvip.com/_serverFn/checkout", {
		method: "POST",
		headers: touch || last ? { cookie: cookies.join("; ") } : {},
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

	it("ignores sign-in returns stored in older cookies", async () => {
		await recordOrderAttribution(
			db,
			"search-paid",
			cookieRequest(
				{ v: 1, r: "accounts.google.com", p: "/", t: 10 },
				{ v: 1, r: "accounts.google.com", p: "/account", t: 20 },
			),
		);
		await recordOrderAttribution(
			db,
			"ai-paid",
			cookieRequest(
				{ v: 1, r: "www.baidu.com", p: "/", t: 11 },
				{
					v: 1,
					r: "accounts.google.com",
					s: "renewal",
					m: "email",
					c: "recall",
					p: "/account",
					t: 21,
				},
			),
		);
		const rows = await db
			.prepare(
				`SELECT order_id, source_category, referrer_host, last_source_category,
				 last_referrer_host, last_utm_campaign FROM order_attribution ORDER BY order_id`,
			)
			.all();
		expect(rows.results).toEqual([
			{
				order_id: "ai-paid",
				source_category: "search",
				referrer_host: "www.baidu.com",
				last_source_category: "email",
				last_referrer_host: null,
				last_utm_campaign: "recall",
			},
			{
				order_id: "search-paid",
				source_category: "direct",
				referrer_host: null,
				last_source_category: null,
				last_referrer_host: null,
				last_utm_campaign: null,
			},
		]);
	});

	it("stores the latest non-direct touch next to the first touch", async () => {
		await recordOrderAttribution(
			db,
			"search-paid",
			cookieRequest(
				{ v: 1, r: "www.baidu.com", p: "/", t: 10 },
				{
					v: 1,
					s: "renewal",
					m: "email",
					c: "renew_3d",
					p: "/products/plus",
					t: 20,
					i: "wechat",
				},
			),
		);
		await recordOrderAttribution(
			db,
			"ai-paid",
			cookieRequest(
				{ v: 1, p: "/", t: 11, i: "wechat" },
				{ v: 1, p: "/", t: 12, f: 1 },
			),
		);
		await recordOrderAttribution(
			db,
			"ai-pending",
			cookieRequest({ v: 1, p: "/", t: 13, i: "telegram" }),
		);
		const rows = await db
			.prepare(
				`SELECT order_id, source_category, in_app_browser, last_source_category,
				 last_utm_source, last_utm_campaign, last_landing_path, last_seen_at,
				 last_in_app_browser FROM order_attribution ORDER BY order_id`,
			)
			.all();
		expect(rows.results).toEqual([
			{
				order_id: "ai-paid",
				source_category: "wechat_in_app",
				in_app_browser: "wechat",
				last_source_category: "referral",
				last_utm_source: null,
				last_utm_campaign: null,
				last_landing_path: "/",
				last_seen_at: 12,
				last_in_app_browser: null,
			},
			{
				order_id: "ai-pending",
				source_category: "telegram_in_app",
				in_app_browser: "telegram",
				last_source_category: null,
				last_utm_source: null,
				last_utm_campaign: null,
				last_landing_path: null,
				last_seen_at: null,
				last_in_app_browser: null,
			},
			{
				order_id: "search-paid",
				source_category: "search",
				in_app_browser: null,
				last_source_category: "email",
				last_utm_source: "renewal",
				last_utm_campaign: "renew_3d",
				last_landing_path: "/products/plus",
				last_seen_at: 20,
				last_in_app_browser: "wechat",
			},
		]);
	});

	it("reports first- and last-touch channels with campaign breakdowns", async () => {
		await recordOrderAttribution(
			db,
			"search-paid",
			cookieRequest(
				{ v: 1, r: "www.baidu.com", p: "/" },
				{ v: 1, s: "renewal", m: "email", c: "renew_3d", p: "/" },
			),
		);
		await recordOrderAttribution(
			db,
			"ai-paid",
			cookieRequest(
				{ v: 1, r: "chatgpt.com", p: "/" },
				{ v: 1, s: "renewal", m: "email", c: "recall", p: "/" },
			),
		);
		await recordOrderAttribution(
			db,
			"ai-pending",
			cookieRequest({ v: 1, r: "chatgpt.com", p: "/" }),
		);
		await recordOrderAttribution(
			db,
			"direct-yesterday",
			cookieRequest({ v: 1, p: "/", f: 1 }),
		);
		const report = await loadAttributionReport(db, 7, now);
		// The original first-touch shape stays as it was.
		expect(report.rows.map((row) => [row.date, row.category])).toEqual([
			["2026-10-21", "ai"],
			["2026-10-21", "search"],
			["2026-10-21", "unattributed"],
			["2026-10-20", "referral"],
		]);
		expect(report.firstTouch.byChannel.totals).toEqual([
			{
				date: "total",
				channel: "ai",
				currency: "CNY",
				orders: 2,
				paidOrders: 1,
				paidAmountMinor: "12000",
			},
			expect.objectContaining({ channel: "referral", paidOrders: 1 }),
			expect.objectContaining({ channel: "search", paidOrders: 1 }),
			expect.objectContaining({ channel: "unattributed", paidOrders: 1 }),
		]);
		// No last-touch cookie: falls back to the first touch.
		expect(report.lastTouch.byChannel.rows).toEqual([
			{
				date: "2026-10-21",
				channel: "ai",
				currency: "CNY",
				orders: 1,
				paidOrders: 0,
				paidAmountMinor: "0",
			},
			{
				date: "2026-10-21",
				channel: "email",
				currency: "CNY",
				orders: 2,
				paidOrders: 2,
				paidAmountMinor: "16000",
			},
			expect.objectContaining({ date: "2026-10-21", channel: "unattributed" }),
			expect.objectContaining({ date: "2026-10-20", channel: "referral" }),
		]);
		expect(report.lastTouch.byCampaign.totals).toEqual(
			expect.arrayContaining([
				{
					date: "total",
					channel: "email",
					utmSource: "renewal",
					utmMedium: "email",
					utmCampaign: "recall",
					currency: "CNY",
					orders: 1,
					paidOrders: 1,
					paidAmountMinor: "12000",
				},
				{
					date: "total",
					channel: "email",
					utmSource: "renewal",
					utmMedium: "email",
					utmCampaign: "renew_3d",
					currency: "CNY",
					orders: 1,
					paidOrders: 1,
					paidAmountMinor: "4000",
				},
			]),
		);
		expect(report.firstTouch.byCampaign.rows).toContainEqual(
			expect.objectContaining({
				date: "2026-10-21",
				channel: "ai",
				utmSource: null,
				orders: 2,
			}),
		);
	});
});

describe("order attribution last-touch migration", { timeout: 30_000 }, () => {
	it("keeps existing first-touch rows and accepts the new categories", async () => {
		const miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		try {
			const db = await miniflare.getD1Database("DB");
			await applyMigrations(db, "0054_alipay_qr_split.sql");
			await db.batch([
				db.prepare(
					`INSERT INTO shop_orders
					 (id, order_number, status, currency, currency_decimals,
					  subtotal_minor, total_minor, expires_at, created_at, updated_at)
					 VALUES ('o1', 'GMo1', 'completed', 'CNY', 2, '100', '100', 1, 1, 1),
					        ('o2', 'GMo2', 'completed', 'CNY', 2, '100', '100', 1, 1, 1)`,
				),
				db.prepare(
					`INSERT INTO order_attribution
					 (order_id, source_category, referrer_host, utm_source, utm_medium,
					  utm_campaign, landing_path, first_seen_at, created_at)
					 VALUES ('o1', 'search', 'www.baidu.com', 's', 'm', 'c', '/p', 5, 6)`,
				),
			]);
			const migration = await readFile(
				new URL(
					"../../drizzle/0055_order_attribution_last_touch.sql",
					import.meta.url,
				),
				"utf8",
			);
			await db.batch(
				migration
					.split("--> statement-breakpoint")
					.map((statement) => statement.trim())
					.filter(Boolean)
					.map((statement) => db.prepare(statement)),
			);
			expect(
				await db.prepare("SELECT * FROM order_attribution").first(),
			).toEqual({
				order_id: "o1",
				source_category: "search",
				referrer_host: "www.baidu.com",
				utm_source: "s",
				utm_medium: "m",
				utm_campaign: "c",
				landing_path: "/p",
				first_seen_at: 5,
				in_app_browser: null,
				last_source_category: null,
				last_referrer_host: null,
				last_utm_source: null,
				last_utm_medium: null,
				last_utm_campaign: null,
				last_landing_path: null,
				last_seen_at: null,
				last_in_app_browser: null,
				created_at: 6,
			});
			await db
				.prepare(
					`INSERT INTO order_attribution
					 (order_id, source_category, in_app_browser, last_source_category)
					 VALUES ('o2', 'wechat_in_app', 'wechat', 'referral')`,
				)
				.run();
			await expect(
				db
					.prepare(
						"UPDATE order_attribution SET last_source_category = 'unknown' WHERE order_id = 'o2'",
					)
					.run(),
			).rejects.toThrow(/CHECK/);
			await expect(
				db
					.prepare(
						"UPDATE order_attribution SET in_app_browser = 'line' WHERE order_id = 'o2'",
					)
					.run(),
			).rejects.toThrow(/CHECK/);
			// Deleting an order still cascades to its attribution row.
			await db.prepare("DELETE FROM shop_orders WHERE id = 'o1'").run();
			expect(
				await db
					.prepare("SELECT COUNT(*) AS n FROM order_attribution")
					.first("n"),
			).toBe(1);
		} finally {
			await miniflare.dispose();
		}
	});
});
