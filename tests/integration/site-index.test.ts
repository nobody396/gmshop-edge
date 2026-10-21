import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listIndexedProducts,
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
