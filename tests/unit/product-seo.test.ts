import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("#/features/storefront/server/catalog", () => ({
	getStorefrontProductFn: vi.fn(),
}));

const {
	createProductSeoHead,
	plainTextSnippet,
	productJsonLd,
	productPriceSummary,
	productSeoDescription,
} = await import("#/features/storefront/product-seo");
const { createArticleSeoHead, createHomeSeoHead } = await import("#/lib/seo");

type Product = Parameters<typeof productJsonLd>[0];
type Item = Product["sellableItems"][number];

function item(overrides: Partial<Item>): Item {
	return {
		id: crypto.randomUUID(),
		name: "Plus 1个月",
		listPriceMinor: null,
		priceMinor: "4000",
		currency: "CNY",
		currencyDecimals: 2,
		minimumQuantity: 1,
		maximumQuantity: 1,
		maximumPerCustomer: null,
		deliveryComponentId: "component",
		deliveryType: "stock",
		fulfillmentSource: "local",
		durationMs: null,
		usageLimit: null,
		accessLimit: null,
		renewalMode: "disabled",
		emailMode: "none",
		showOnOrderPage: true,
		allowResend: false,
		saleDisabled: false,
		availableStock: 3,
		channelPrices: [],
		policy: {
			delivery: "",
			deliveryTime: "",
			coverage: "",
			warranty: "",
			restrictions: "",
		},
		...overrides,
	} as Item;
}

function product(overrides: Partial<Product> = {}): Product {
	return {
		id: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		name: "ChatGPT 会员充值",
		description: "ChatGPT Go、Plus 与 Pro 订阅充值。",
		productType: "stock",
		saleDisabled: false,
		tags: ["OpenAI"],
		coverUrl: "/api/shop/products/2a794b89/cover?v=1",
		sellableItems: [
			item({ name: "Go", priceMinor: "4000" }),
			item({ name: "Pro", priceMinor: "120000" }),
			item({ name: "停售", priceMinor: "100", saleDisabled: true }),
		],
		inputs: [],
		media: [],
		...overrides,
	} as Product;
}

describe("product SEO", () => {
	it("prices only purchasable plans and reports stock", () => {
		expect(productPriceSummary(product())).toMatchObject({
			lowMinor: 4000n,
			highMinor: 120000n,
			offerCount: 2,
			inStock: true,
		});
		expect(
			productPriceSummary(
				product({
					sellableItems: [item({ availableStock: 0 })],
				}),
			),
		).toMatchObject({ inStock: false });
		expect(
			productPriceSummary(
				product({ sellableItems: [item({ availableStock: -1 })] }),
			),
		).toMatchObject({ inStock: true });
		expect(productPriceSummary(product({ saleDisabled: true }))).toMatchObject({
			inStock: false,
		});
	});

	it("never prices the quote-based ChatGPT upgrade from its zero placeholder", () => {
		expect(
			productPriceSummary(
				product({ id: "10000000-0000-4000-8000-000000000001" }),
			),
		).toBeNull();
	});

	it("builds a distinct title, canonical, Open Graph and Product JSON-LD", () => {
		const head = createProductSeoHead(product(), "老实人AI", "zh-CN");
		expect(head.meta).toContainEqual({
			title: "ChatGPT 会员充值｜24 小时自动发货 – 老实人AI",
		});
		expect(head.links).toEqual([
			{
				rel: "canonical",
				href: "https://laoshirenvip.com/products/2a794b89-3bb9-49d4-8691-0d13a1606869",
			},
		]);
		expect(head.meta).toContainEqual({
			property: "og:image",
			content: "https://laoshirenvip.com/api/shop/products/2a794b89/cover?v=1",
		});
		const jsonLd = JSON.parse(head.scripts[0]?.children ?? "{}");
		expect(jsonLd).toMatchObject({
			"@type": "Product",
			name: "ChatGPT 会员充值",
			offers: {
				"@type": "AggregateOffer",
				lowPrice: "40.00",
				highPrice: "1200.00",
				priceCurrency: "CNY",
				offerCount: 2,
				availability: "https://schema.org/InStock",
			},
		});
	});

	it("lists one Offer per sellable plan with its public price and stock", () => {
		const go = item({ name: "Go", priceMinor: "4000", availableStock: 0 });
		const pro = item({ name: "Pro", priceMinor: "120000", availableStock: -1 });
		const paused = item({
			name: "停售",
			priceMinor: "100",
			saleDisabled: true,
		});
		const jsonLd = productJsonLd(
			product({ sellableItems: [go, pro, paused] }),
			"zh-CN",
		);
		const base =
			"https://laoshirenvip.com/products/2a794b89-3bb9-49d4-8691-0d13a1606869";
		expect(jsonLd.offers?.offers).toEqual([
			{
				"@type": "Offer",
				name: "Go",
				sku: go.id,
				price: "40.00",
				priceCurrency: "CNY",
				availability: "https://schema.org/OutOfStock",
				url: `${base}?item=${go.id}`,
			},
			{
				"@type": "Offer",
				name: "Pro",
				sku: pro.id,
				price: "1200.00",
				priceCurrency: "CNY",
				availability: "https://schema.org/InStock",
				url: `${base}?item=${pro.id}`,
			},
		]);
		const serialized = JSON.stringify(jsonLd);
		expect(serialized).not.toContain(paused.id);
		expect(serialized).not.toMatch(/cost|supplier|agent/i);
		// A single-plan product's offer points at the product page itself.
		const single = productJsonLd(
			product({ sellableItems: [go], saleDisabled: true }),
			"zh-CN",
		);
		expect(single.offers?.offers).toMatchObject([
			{ url: base, availability: "https://schema.org/OutOfStock" },
		]);
		// The quote-based upgrade publishes no prices at all.
		expect(
			productJsonLd(product({ id: "10000000-0000-4000-8000-000000000001" }))
				.offers,
		).toBeUndefined();
	});

	it("turns a valid ?item= into its own landing page", () => {
		const us = item({
			name: "美区",
			priceMinor: "1500",
			policy: {
				delivery: "",
				deliveryTime: "",
				coverage:
					"美区独享 Apple ID 老号（注册 1 年以上），带密保问题，可自行修改密码。",
				warranty: "登录不上质保期内免费换号",
				restrictions: "",
			},
		});
		const jp = item({ name: "日区", priceMinor: "1500" });
		const paused = item({ name: "土区", saleDisabled: true });
		const appleId = product({
			name: "Apple ID 成品号",
			sellableItems: [us, jp, paused],
		});
		const base =
			"https://laoshirenvip.com/products/2a794b89-3bb9-49d4-8691-0d13a1606869";
		const head = createProductSeoHead(appleId, "老实人AI", "zh-CN", us.id);
		expect(head.meta).toContainEqual({
			title: "Apple ID 成品号｜美区｜¥15.00 – 老实人AI",
		});
		expect(head.meta).toContainEqual({
			name: "description",
			content:
				"Apple ID 成品号「美区」规格，售价 ¥15.00，有货，付款后自动发货。美区独享 Apple ID 老号（注册 1 年以上），带密保问题，可自行修改密码；登录不上质保期内免费换号。",
		});
		expect(head.links).toEqual([
			{ rel: "canonical", href: `${base}?item=${us.id}` },
		]);
		expect(head.meta).toContainEqual({
			property: "og:url",
			content: `${base}?item=${us.id}`,
		});
		const jsonLd = JSON.parse(head.scripts[0]?.children ?? "{}");
		expect(jsonLd).toMatchObject({
			"@type": "Product",
			name: "Apple ID 成品号｜美区",
			url: `${base}?item=${us.id}`,
			offers: { "@type": "Offer", price: "15.00", priceCurrency: "CNY" },
		});
		// Distinct specs get distinct titles and descriptions.
		const other = createProductSeoHead(appleId, "老实人AI", "zh-CN", jp.id);
		expect(other.meta[0]).not.toEqual(head.meta[0]);

		// Paused, unknown and single-plan items fall back to the product page.
		for (const fallback of [
			createProductSeoHead(appleId, "老实人AI", "zh-CN", paused.id),
			createProductSeoHead(appleId, "老实人AI", "zh-CN", crypto.randomUUID()),
			createProductSeoHead(
				product({ sellableItems: [us] }),
				"老实人AI",
				"zh-CN",
				us.id,
			),
			createProductSeoHead(
				{ ...appleId, saleDisabled: true },
				"老实人AI",
				"zh-CN",
				us.id,
			),
		])
			expect(fallback.links).toEqual([{ rel: "canonical", href: base }]);
	});

	it("keeps JSON-LD from closing its script element", () => {
		const head = createProductSeoHead(
			product({ name: "</script><script>alert(1)</script>" }),
			"老实人AI",
			"zh-CN",
		);
		const script = head.scripts[0]?.children ?? "";
		expect(script).not.toContain("</script>");
		expect(JSON.parse(script).name).toBe("</script><script>alert(1)</script>");
	});

	it("summarises stored HTML descriptions and falls back to plans", () => {
		expect(plainTextSnippet("<p>第一行</p>\n<strong>第二行</strong>")).toBe(
			"第一行 第二行",
		);
		expect(Array.from(plainTextSnippet("长".repeat(300))).length).toBe(121);
		expect(productSeoDescription(product({ description: null }), "zh-CN")).toBe(
			"ChatGPT 会员充值：Go、Pro、停售。¥40.00 起，24 小时自动发货，付款后自动交付卡密。",
		);
	});

	it("adds Organization, WebSite search and Article structured data", () => {
		const home = JSON.parse(
			createHomeSeoHead([{ loaderData: { name: "老实人AI" } }]).scripts[0]
				?.children ?? "{}",
		);
		expect(
			home["@graph"].map((node: { "@type": string }) => node["@type"]),
		).toEqual(["Organization", "WebSite"]);
		expect(home["@graph"][1].potentialAction.target.urlTemplate).toBe(
			"https://laoshirenvip.com/?search={search_term_string}",
		);
		const article = createArticleSeoHead([], {
			title: "教程",
			description: "说明",
			path: "/guides/apple-id-login",
		});
		expect(article.links).toEqual([
			{
				rel: "canonical",
				href: "https://laoshirenvip.com/guides/apple-id-login",
			},
		]);
		expect(article.meta).toContainEqual({
			property: "og:type",
			content: "article",
		});
		expect(JSON.parse(article.scripts[0]?.children ?? "{}")["@type"]).toBe(
			"Article",
		);
	});

	it("announces the sitemap in robots.txt and keeps crawling open", () => {
		const robots = readFileSync(resolve("public/robots.txt"), "utf8");
		expect(robots).toContain("Sitemap: https://laoshirenvip.com/sitemap.xml");
		expect(robots).toMatch(/^Disallow:\s*$/m);
	});
});
