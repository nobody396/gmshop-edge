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
