import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listIndexedProducts,
	listIndexedStaticPages,
	renderLlmsTxt,
	renderSitemap,
} from "#/features/seo/server/site-index";
import { applyMigrations } from "./migrations";

const activeId = "11111111-1111-4111-8111-111111111111";
const draftId = "22222222-2222-4222-8222-222222222222";
const manualId = "33333333-3333-4333-8333-333333333333";
const retiredId = "aa277f98-79b4-58cb-8b7b-1424fe930ab9";

describe("sitemap and llms.txt", { timeout: 30_000 }, () => {
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

	it("lists only active products with their lowest purchasable price", async () => {
		const products = await listIndexedProducts(db);
		expect(products.map((product) => product.id)).toEqual([activeId, manualId]);
		expect(products[0]).toMatchObject({
			name: "ChatGPT 会员充值",
			category: "OpenAI",
			minPriceMinor: "4000",
			planCount: 2,
			manualOnly: false,
			updatedAt: 1_790_000_000_000,
		});
		expect(products[1]).toMatchObject({ manualOnly: true, category: "" });
	});

	it("renders a sitemap with home, product lastmod and public guides", async () => {
		const xml = renderSitemap(await listIndexedProducts(db));
		expect(xml).toContain("<loc>https://laoshirenvip.com/</loc>");
		expect(xml).toContain(
			`<loc>https://laoshirenvip.com/products/${activeId}</loc>\n    <lastmod>${new Date(1_790_000_000_000).toISOString()}</lastmod>`,
		);
		expect(xml).toContain(
			"<loc>https://laoshirenvip.com/guides/apple-id-login</loc>",
		);
		expect(xml).toContain(
			"<loc>https://laoshirenvip.com/guides/claude-network-check</loc>",
		);
		expect(xml).not.toContain(draftId);
		expect(xml).not.toContain(retiredId);
	});

	it("lists spec landing URLs for public plans of multi-plan products", async () => {
		const appleId = "44444444-4444-4444-8444-444444444444";
		const us = "55555555-5555-4555-8555-555555555551";
		const jp = "55555555-5555-4555-8555-555555555552";
		const paused = "55555555-5555-4555-8555-555555555553";
		const disabled = "55555555-5555-4555-8555-555555555554";
		await db.batch([
			db
				.prepare(
					`INSERT INTO products (id, name, description, product_type, status,
					  tag_names, sort_order, revision, created_at, updated_at)
					 VALUES (?, 'Apple ID 成品号', NULL, 'stock', 'active', '["Apple"]', 5, 1, 1, 1795000000000)`,
				)
				.bind(appleId),
			db
				.prepare(
					`INSERT INTO product_sellable_items
					 (id, product_id, name, currency, currency_decimals, price_minor,
					  fulfillment_source, minimum_quantity, maximum_quantity, enabled,
					  sale_disabled, sort_order, created_at, updated_at)
					 VALUES (?1, ?5, '美区', 'CNY', 2, '1500', 'local', 1, 1, 1, 0, 1, 1, 1),
					        (?2, ?5, '日区', 'CNY', 2, '1500', 'local', 1, 1, 1, 0, 2, 1, 1),
					        (?3, ?5, '土区', 'CNY', 2, '1500', 'local', 1, 1, 1, 1, 3, 1, 1),
					        (?4, ?5, '菲区', 'CNY', 2, '1500', 'local', 1, 1, 0, 0, 4, 1, 1)`,
				)
				.bind(us, jp, paused, disabled, appleId),
		]);
		const products = await listIndexedProducts(db);
		expect(products.find((product) => product.id === appleId)).toMatchObject({
			planCount: 2,
			landingItemIds: [us, jp],
		});
		// Non-UUID ids are never honoured by the storefront, so never listed.
		expect(
			products.find((product) => product.id === activeId)?.landingItemIds,
		).toEqual([]);
		const xml = renderSitemap(products);
		const lastmod = new Date(1_795_000_000_000).toISOString();
		for (const id of [us, jp])
			expect(xml).toContain(
				`<loc>https://laoshirenvip.com/products/${appleId}?item=${id}</loc>\n    <lastmod>${lastmod}</lastmod>`,
			);
		expect(xml).not.toContain(paused);
		expect(xml).not.toContain(disabled);
	});

	it("dates hand-built pages, following the App Store price snapshot", async () => {
		const before = await listIndexedStaticPages(db);
		expect(before.map((page) => page.path)).toEqual([
			"/guides/apple-id-login",
			"/guides/appstore-prices",
			"/guides/claude-network-check",
			"/ip-check",
		]);
		for (const page of before) expect(page.updatedAt).toBeGreaterThan(0);
		await db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('appstore_prices.snapshot', '{}', 0, 1, 1900000000000)`,
			)
			.run();
		const after = await listIndexedStaticPages(db);
		expect(
			after.find((page) => page.path === "/guides/appstore-prices")?.updatedAt,
		).toBe(1_900_000_000_000);
		const xml = renderSitemap([], [], after);
		expect(xml).toContain(
			`<loc>https://laoshirenvip.com/guides/appstore-prices</loc>\n    <lastmod>${new Date(1_900_000_000_000).toISOString()}</lastmod>`,
		);
		const entries = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
		expect(entries.length).toBe(6);
		for (const entry of entries) expect(entry).toContain("<lastmod>");
	});

	it("describes the live catalog in Chinese without banned phrasing", async () => {
		const text = renderLlmsTxt(await listIndexedProducts(db), "老实人AI");
		expect(text).toMatch(/^# 老实人AI\n/);
		expect(text).toContain("### OpenAI");
		expect(text).toContain(
			`- [ChatGPT 会员充值](https://laoshirenvip.com/products/${activeId})，¥40.00 起，2 个规格，24 小时自动发货`,
		);
		expect(text).toContain("### 其他");
		expect(text).toContain("客服人工处理");
		expect(text).toContain("30 天订阅质保");
		expect(text).toContain("https://laoshirenvip.com/sitemap.xml");
		for (const banned of [
			"翻墙",
			"梯子",
			"科学上网",
			"破解",
			"共享号",
			"车队",
			"100%不封",
		])
			expect(text).not.toContain(banned);
	});
});

async function seed(db: D1Database) {
	await db.batch([
		db
			.prepare(
				`INSERT INTO products
				 (id, name, description, product_type, status, tag_names, sort_order,
				  revision, created_at, updated_at)
				 VALUES (?, 'ChatGPT 会员充值', '<p>Go、Plus 与 Pro 订阅充值</p>', 'stock', 'active', '["OpenAI"]', 1, 1, 1, 1790000000000),
				        (?, '草稿商品', NULL, 'stock', 'draft', '[]', 2, 1, 1, 1),
				        (?, '人工商品', NULL, 'stock', 'active', '[]', 3, 1, 1, 1),
				        (?, '已下线商品', NULL, 'stock', 'active', '[]', 4, 1, 1, 1)`,
			)
			.bind(activeId, draftId, manualId, retiredId),
		db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, currency, currency_decimals, price_minor,
				  fulfillment_source, minimum_quantity, maximum_quantity, enabled,
				  sale_disabled, sort_order, created_at, updated_at)
				 VALUES ('item-go', ?, 'Go', 'CNY', 2, '4000', 'local', 1, 1, 1, 0, 1, 1, 1),
				        ('item-pro', ?, 'Pro', 'CNY', 2, '120000', 'local', 1, 1, 1, 0, 2, 1, 1),
				        ('item-off', ?, 'Off', 'CNY', 2, '100', 'local', 1, 1, 1, 1, 3, 1, 1),
				        ('item-manual', ?, 'Manual', 'CNY', 2, '5000', 'manual', 1, 1, 1, 0, 1, 1, 1)`,
			)
			.bind(activeId, activeId, activeId, manualId),
	]);
}
