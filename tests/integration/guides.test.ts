import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleGuidesOpsRequest } from "#/features/guides/server/ops-api";
import {
	loadPublicGuide,
	loadPublicGuideList,
} from "#/features/guides/server/public-guide";
import {
	listIndexedGuides,
	listIndexedProducts,
	renderLlmsTxt,
	renderSitemap,
} from "#/features/seo/server/site-index";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { applyMigrations } from "./migrations";

const productId = "11111111-1111-4111-8111-111111111111";
const soldOutProductId = "22222222-2222-4222-8222-222222222222";
const draftProductId = "33333333-3333-4333-8333-333333333333";
const origin = "https://laoshirenvip.com/api/ops/guides";

const article = {
	title: "ChatGPT Plus 充值教程",
	description: "付款后自动发卡，按订单页提示兑换。",
	bodyMd: [
		"# 不该出现的一级标题",
		"",
		"Plus 月卡现价 {{price:item-plus}}，Pro 现在 {{price:item-pro}}。",
		"",
		"去购买：{{product:11111111-1111-4111-8111-111111111111}}",
		"",
		"失效：{{price:item-hidden}}{{product:33333333-3333-4333-8333-333333333333}}",
		"",
		"<script>alert(1)</script>",
	].join("\n"),
	faq: [{ q: "多久到账？", a: "付款后自动发放卡密。" }],
	relatedProductIds: [productId, soldOutProductId, draftProductId],
	source: "auto",
};

describe("guides ops API and public pages", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let env: CloudflareBindings;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
		env = { DB: db, RESTOCK_API_TOKEN: "ops-token" } as CloudflareBindings;
	});

	afterEach(async () => miniflare.dispose());

	function call(
		path: string,
		init: { method?: string; body?: unknown; token?: string | null } = {},
		route: Parameters<typeof handleGuidesOpsRequest>[2] = {},
	) {
		const headers = new Headers();
		if (init.token !== null)
			headers.set("authorization", `Bearer ${init.token ?? "ops-token"}`);
		if (init.body !== undefined)
			headers.set("content-type", "application/json");
		return handleGuidesOpsRequest(
			new Request(`${origin}${path}`, {
				method: init.method ?? "GET",
				headers,
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			}),
			env,
			route,
		);
	}

	const put = (slug: string, body: unknown) =>
		call(`/${slug}`, { method: "PUT", body }, { slug });
	const publish = (slug: string, body?: unknown) =>
		call(
			`/${slug}/publish`,
			{ method: "POST", body },
			{ slug, action: "publish" },
		);
	const unpublish = (slug: string) =>
		call(
			`/${slug}/unpublish`,
			{ method: "POST" },
			{ slug, action: "unpublish" },
		);

	it("requires the ops token", async () => {
		expect((await call("", { token: null })).status).toBe(401);
		expect((await call("", { token: "wrong" })).status).toBe(401);
		expect(
			(
				await call(
					"/a-b",
					{ method: "PUT", body: article, token: null },
					{ slug: "a-b" },
				)
			).status,
		).toBe(401);
		expect((await call("")).status).toBe(200);
	});

	it("validates slugs and payloads", async () => {
		expect((await put("Bad_Slug", article)).status).toBe(400);
		const reserved = await put("apple-id-login", article);
		expect(reserved.status).toBe(400);
		await expect(reserved.json()).resolves.toMatchObject({
			error: "guide_slug_reserved",
		});
		const invalid = await put("ok-slug", {
			...article,
			title: "长".repeat(61),
		});
		expect(invalid.status).toBe(400);
		await expect(invalid.json()).resolves.toMatchObject({
			error: "guide_invalid",
			issues: [expect.objectContaining({ path: "title" })],
		});
	});

	it("rejects banned words on upsert and on publish", async () => {
		const rejected = await put("risky", {
			...article,
			faq: [{ q: "需要梯子吗？", a: "不用 vpn" }],
		});
		expect(rejected.status).toBe(422);
		await expect(rejected.json()).resolves.toEqual({
			ok: false,
			error: "guide_banned_words",
			words: ["梯子", "VPN"],
		});
		expect((await call("")).status).toBe(200);
		await expect((await call("")).json()).resolves.toMatchObject({
			guides: [],
		});

		// A row that predates a list change is still stopped at publish.
		expect((await put("legacy", article)).status).toBe(201);
		await db
			.prepare(
				"UPDATE guides SET body_md = body_md || ' 官方授权' WHERE slug = 'legacy'",
			)
			.run();
		const blocked = await publish("legacy");
		expect(blocked.status).toBe(422);
		await expect(blocked.json()).resolves.toMatchObject({
			words: ["官方授权"],
		});
	});

	it("upserts drafts, publishes, unpublishes with revisions", async () => {
		const created = await put("chatgpt-plus", article);
		expect(created.status).toBe(201);
		const createdBody = (await created.json()) as {
			guide: { revision: number; status: string; source: string };
			unresolvedTokens: string[];
		};
		expect(createdBody.guide).toMatchObject({
			revision: 1,
			status: "draft",
			source: "auto",
		});
		expect(createdBody.unresolvedTokens).toEqual([
			"{{price:item-hidden}}",
			"{{product:33333333-3333-4333-8333-333333333333}}",
		]);

		expect(await loadPublicGuide(db, "chatgpt-plus")).toBeNull();

		const stale = await put("chatgpt-plus", { ...article, revision: 9 });
		expect(stale.status).toBe(409);
		await expect(stale.json()).resolves.toMatchObject({
			error: "guide_revision_conflict",
			currentRevision: 1,
		});
		const updated = await put("chatgpt-plus", {
			...article,
			title: "ChatGPT Plus 充值教程（2026）",
			revision: 1,
		});
		expect(updated.status).toBe(200);
		await expect(updated.json()).resolves.toMatchObject({
			guide: { revision: 2, status: "draft" },
		});

		expect((await publish("missing-guide")).status).toBe(404);
		const published = await publish("chatgpt-plus", { revision: 2 });
		expect(published.status).toBe(200);
		const publishedGuide = (
			(await published.json()) as {
				guide: { status: string; revision: number; publishedAt: number };
			}
		).guide;
		expect(publishedGuide).toMatchObject({ status: "published", revision: 3 });
		expect(publishedGuide.publishedAt).toBeGreaterThan(0);

		const one = await call("/chatgpt-plus", {}, { slug: "chatgpt-plus" });
		await expect(one.json()).resolves.toMatchObject({
			guide: { slug: "chatgpt-plus", bodyMd: article.bodyMd },
		});

		const page = await loadPublicGuide(db, "chatgpt-plus");
		expect(page).not.toBeNull();
		expect(page?.title).toBe("ChatGPT Plus 充值教程（2026）");
		expect(page?.html).toContain("Plus 月卡现价 ¥139.00，Pro 现在 暂时缺货。");
		expect(page?.html).toContain(
			`<a href="/products/${productId}">ChatGPT 会员充值</a>`,
		);
		expect(page?.html).not.toMatch(/\{\{|<script|<h1/);
		expect(page?.faq).toEqual(article.faq);
		expect(page?.relatedProducts).toEqual([
			{
				id: productId,
				name: "ChatGPT 会员充值",
				priceLabel: "¥139.00 起",
				inStock: true,
			},
			{
				id: soldOutProductId,
				name: "售罄商品",
				priceLabel: "¥50.00 起",
				inStock: false,
			},
		]);

		expect((await unpublish("chatgpt-plus")).status).toBe(200);
		expect(await loadPublicGuide(db, "chatgpt-plus")).toBeNull();
	});

	it("lists only published guides in the index, sitemap and llms.txt", async () => {
		await put("published-guide", article);
		await put("draft-guide", { ...article, title: "草稿指南" });
		await publish("published-guide");

		const list = (await (await call("")).json()) as {
			guides: Array<{ slug: string; status: string }>;
		};
		expect(
			list.guides.map((guide) => [guide.slug, guide.status]).sort(),
		).toEqual([
			["draft-guide", "draft"],
			["published-guide", "published"],
		]);

		expect((await loadPublicGuideList(db)).map((guide) => guide.slug)).toEqual([
			"published-guide",
		]);
		const guides = await listIndexedGuides(db);
		const products = await listIndexedProducts(db);
		const xml = renderSitemap(products, guides);
		expect(xml).toContain(
			`<loc>https://laoshirenvip.com/guides/published-guide</loc>\n    <lastmod>${new Date(guides[0]?.updatedAt ?? 0).toISOString()}</lastmod>`,
		);
		expect(xml).toContain("<loc>https://laoshirenvip.com/guides</loc>");
		expect(xml).toContain(
			"<loc>https://laoshirenvip.com/guides/apple-id-login</loc>",
		);
		expect(xml).not.toContain("draft-guide");

		const text = renderLlmsTxt(products, "老实人AI", guides);
		expect(text).toContain(
			"## 指南\n\n- [ChatGPT Plus 充值教程](https://laoshirenvip.com/guides/published-guide)：付款后自动发卡，按订单页提示兑换。",
		);
		expect(text).not.toContain("草稿指南");
	});
});

async function seed(db: D1Database) {
	await db.batch([
		db
			.prepare(
				`INSERT INTO products
				 (id, name, description, product_type, status, tag_names, sort_order,
				  revision, created_at, updated_at)
				 VALUES (?, 'ChatGPT 会员充值', NULL, 'stock', 'active', '["OpenAI"]', 1, 1, 1, 1),
				        (?, '售罄商品', NULL, 'stock', 'active', '[]', 2, 1, 1, 1),
				        (?, '草稿商品', NULL, 'stock', 'draft', '[]', 3, 1, 1, 1)`,
			)
			.bind(productId, soldOutProductId, draftProductId),
		db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, currency, currency_decimals, price_minor,
				  fulfillment_source, minimum_quantity, maximum_quantity, enabled,
				  sale_disabled, sort_order, created_at, updated_at)
				 VALUES ('item-plus', ?, 'Plus', 'CNY', 2, '13900', 'manual', 1, 1, 1, 0, 1, 1, 1),
				        ('item-pro', ?, 'Pro', 'CNY', 2, '150000', 'local', 1, 1, 1, 0, 2, 1, 1),
				        ('item-sold', ?, 'Sold', 'CNY', 2, '5000', 'local', 1, 1, 1, 0, 1, 1, 1),
				        ('item-hidden', ?, 'Hidden', 'CNY', 2, '100', 'manual', 1, 1, 1, 0, 1, 1, 1)`,
			)
			.bind(productId, productId, soldOutProductId, draftProductId),
	]);
}
