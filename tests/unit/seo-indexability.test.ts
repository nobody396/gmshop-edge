import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Every URL the sitemap announces must be indexable, and every utility page
 * must declare noindex through the shared helper. The route modules are
 * imported for real (their head functions run); only page components and
 * server-bound modules are stubbed.
 */
const { routes } = vi.hoisted(() => ({
	routes: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	createFileRoute: (id: string) => (options: Record<string, unknown>) => {
		routes.set(id, options);
		return { options };
	},
}));
vi.mock("#/features/storefront/server/catalog", () => ({
	getStorefrontProductFn: vi.fn(),
}));
vi.mock("#/features/storefront/pages/product", () => ({
	StorefrontProductPage: () => null,
}));
vi.mock("#/features/exchange-rates/currency-context", () => ({
	storeCurrencyConfigurationQueryOptions: vi.fn(),
}));
vi.mock("#/features/home", () => ({ HomePage: () => null }));
vi.mock("#/features/home/catalog-query", () => ({
	storefrontCatalogQueryOptions: vi.fn(),
}));
vi.mock("#/features/guides/pages/guides-index-page", () => ({
	GuidesIndexPage: () => null,
}));
vi.mock("#/features/guides/pages/guide-page", () => ({
	GuidePage: () => null,
}));
vi.mock("#/features/guides/queries", () => ({
	publicGuideListQueryOptions: vi.fn(),
	publicGuideQueryOptions: vi.fn(),
}));
vi.mock("#/features/claude-env/server/customer-email", () => ({
	claudeEnvGuidePath: "/account/claude-env-guide",
	claudeEnvGuideSlug: "claude-env-guide",
}));
vi.mock("#/features/guides/apple-id-login", () => ({
	AppleIdLoginGuide: () => null,
	appleIdLoginGuidePath: "/guides/apple-id-login",
}));
vi.mock("#/features/appstore-prices/page", () => ({
	AppStorePricesPage: () => null,
	appStorePricesQueryOptions: vi.fn(),
}));
vi.mock("#/features/ip-check/guide", () => ({ IpCheckGuide: () => null }));
vi.mock("#/features/ip-check/page", () => ({ IpCheckPage: () => null }));
vi.mock("#/layouts/public", () => ({ PublicLayout: () => null }));

await Promise.all([
	import("../../src/routes/(public)/route"),
	import("../../src/routes/(public)/index"),
	import("../../src/routes/(public)/products/$productId"),
	import("../../src/routes/(public)/guides/index"),
	import("../../src/routes/(public)/guides/$slug"),
	import("../../src/routes/(public)/guides/apple-id-login"),
	import("../../src/routes/(public)/guides/appstore-prices"),
	import("../../src/routes/(public)/guides/claude-network-check"),
	import("../../src/routes/(public)/ip-check"),
]);
const { renderSitemap } = await import("#/features/seo/server/site-index");
const { headIsNoindex, utilityPageHead } = await import("#/lib/seo");

const productId = "c70d10e8-b781-4782-bc98-1f034bcd069a";
const usItem = "8d0b5a8e-3c3f-4f61-9d61-1b2f6f0a0c01";
const jpItem = "8d0b5a8e-3c3f-4f61-9d61-1b2f6f0a0c02";
const singleProductId = "e4acdd84-af47-45fd-99c6-29cb7a2d38b1";
const site = "https://laoshirenvip.com";

function item(id: string, name: string) {
	return {
		id,
		name,
		listPriceMinor: null,
		priceMinor: "1500",
		currency: "CNY",
		currencyDecimals: 2,
		minimumQuantity: 1,
		maximumQuantity: 1,
		maximumPerCustomer: null,
		deliveryComponentId: id,
		deliveryType: "stock",
		fulfillmentSource: "local",
		durationMs: null,
		usageLimit: null,
		accessLimit: null,
		renewalMode: "disabled",
		emailMode: "content",
		showOnOrderPage: true,
		allowResend: false,
		saleDisabled: false,
		availableStock: 5,
		channelPrices: [],
		policy: {
			delivery: "",
			deliveryTime: "",
			coverage: "",
			warranty: "",
			restrictions: "",
		},
	};
}

function productFixture(id: string) {
	return {
		id,
		name: "Apple ID 成品号",
		description:
			"注册 1 年以上的老号，一人一号独享，带密保问题，可以自己改密码。",
		productType: "stock",
		saleDisabled: false,
		tags: ["Apple"],
		coverUrl: null,
		sellableItems:
			id === productId
				? [item(usItem, "美区"), item(jpItem, "日区")]
				: [item(usItem, "美区")],
		inputs: [],
		media: [],
	};
}

const guide = {
	slug: "chatgpt-chile-pro",
	title: "智利区 ChatGPT Pro 是什么？",
	description: "说明",
	bodyMd: "",
	faq: [],
	publishedAt: 1,
	updatedAt: 1,
};

const sitemap = renderSitemap(
	[
		{
			id: productId,
			name: "Apple ID 成品号",
			description: "",
			category: "Apple",
			updatedAt: 1_790_000_000_000,
			minPriceMinor: "1500",
			currency: "CNY",
			currencyDecimals: 2,
			planCount: 2,
			manualOnly: false,
			landingItemIds: [usItem, jpItem],
		},
		{
			id: singleProductId,
			name: "Gmail",
			description: "",
			category: "邮箱",
			updatedAt: 1_790_000_000_000,
			minPriceMinor: "1500",
			currency: "CNY",
			currencyDecimals: 2,
			planCount: 1,
			manualOnly: false,
			landingItemIds: [],
		},
	],
	[
		{
			slug: guide.slug,
			title: guide.title,
			description: guide.description,
			updatedAt: 1,
		},
	],
);
const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) =>
	(match[1] ?? "").replace(/&amp;/g, "&"),
);

const staticGuideRoutes = new Set([
	"apple-id-login",
	"appstore-prices",
	"claude-network-check",
]);

/** The route chain (layout first) that serves a sitemap URL. */
function routeChain(url: URL) {
	const path = url.pathname;
	const leaf =
		path === "/"
			? "/(public)/"
			: path === "/guides"
				? "/(public)/guides/"
				: path === "/ip-check"
					? "/(public)/ip-check"
					: path.startsWith("/products/")
						? "/(public)/products/$productId"
						: path.startsWith("/guides/")
							? staticGuideRoutes.has(path.slice("/guides/".length))
								? `/(public)${path}`
								: "/(public)/guides/$slug"
							: null;
	if (!leaf) throw new Error(`No route mapping for sitemap URL ${url.href}`);
	return ["/(public)", leaf];
}

type Head = {
	meta?: unknown[];
	links?: Array<{ rel?: string; href?: string }>;
};

function headFor(routeId: string, url: URL): Head | undefined {
	const options = routes.get(routeId);
	if (!options) throw new Error(`Route ${routeId} was not registered`);
	const head = options.head as ((context: unknown) => Head) | undefined;
	if (!head) return undefined;
	const loaderData = routeId.includes("$productId")
		? productFixture(url.pathname.split("/")[2] ?? "")
		: routeId.includes("$slug")
			? guide
			: undefined;
	return head({
		matches: [{ loaderData: { name: "老实人AI" } }],
		match: { search: Object.fromEntries(url.searchParams) },
		params: {},
		loaderData,
	});
}

describe("search indexability", () => {
	it("covers products, spec landing URLs, guides and tool pages", () => {
		expect(locations).toContain(`${site}/products/${productId}`);
		expect(locations).toContain(`${site}/products/${productId}?item=${usItem}`);
		expect(locations).toContain(`${site}/products/${productId}?item=${jpItem}`);
		expect(locations).not.toContain(
			`${site}/products/${singleProductId}?item=${usItem}`,
		);
		expect(locations).toContain(`${site}/guides/apple-id-login`);
		expect(locations).toContain(`${site}/ip-check`);
	});

	it("never marks a sitemap URL noindex, and canonicals point back at it", () => {
		expect(locations.length).toBeGreaterThan(8);
		for (const location of locations) {
			const url = new URL(location);
			for (const routeId of routeChain(url)) {
				const head = headFor(routeId, url);
				expect(headIsNoindex(head), `${location} via ${routeId}`).toBe(false);
				const canonical = head?.links?.find((link) => link.rel === "canonical");
				if (canonical) expect(canonical.href, location).toBe(location);
			}
		}
	});

	it("gives every sitemap URL a lastmod", () => {
		const entries = sitemap.match(/<url>[\s\S]*?<\/url>/g) ?? [];
		expect(entries.length).toBe(locations.length);
		for (const entry of entries) expect(entry).toContain("<lastmod>");
	});

	it("drops tracking parameters and unknown items from product canonicals", () => {
		const tracked = new URL(
			`${site}/products/${productId}?item=${usItem}&utm_source=chatgpt.com&ref=abc`,
		);
		const head = headFor("/(public)/products/$productId", tracked);
		expect(head?.links).toEqual([
			{
				rel: "canonical",
				href: `${site}/products/${productId}?item=${usItem}`,
			},
		]);
		const unknown = new URL(
			`${site}/products/${productId}?item=00000000-0000-4000-8000-000000000000`,
		);
		expect(headFor("/(public)/products/$productId", unknown)?.links).toEqual([
			{ rel: "canonical", href: `${site}/products/${productId}` },
		]);
	});

	it("marks utility pages noindex, follow through the shared helper", () => {
		expect(utilityPageHead().meta).toEqual([
			{ name: "robots", content: "noindex, follow" },
		]);
		expect(headIsNoindex(utilityPageHead({ title: "购物车" }))).toBe(true);
		const read = (path: string) =>
			readFileSync(resolve("src/routes", path), "utf8");
		const layouts = [
			"(auth)/route.tsx",
			"(public)/account/route.tsx",
			"admin/route.tsx",
		];
		for (const layout of layouts)
			expect(read(layout), layout).toContain("head: () => utilityPageHead(");
		for (const page of [
			"(auth)/sign-in.tsx",
			"(auth)/register.tsx",
			"(auth)/forgot-password.tsx",
			"(auth)/verify-email-sent.tsx",
			"(errors)/401.tsx",
			"(errors)/403.tsx",
			"(errors)/404.tsx",
			"(errors)/500.tsx",
			"(errors)/503.tsx",
			"(public)/cart.tsx",
			"(public)/checkout/index.tsx",
			"(public)/invoice.tsx",
			"(public)/me.tsx",
			"(public)/orders/index.tsx",
			"(public)/orders/$orderNumber.tsx",
			"(public)/status.tsx",
			"(public)/unsubscribe/renewal.tsx",
			"(public)/upgrade/checkout.tsx",
			"(public)/account/claude-env.tsx",
			"(public)/account/claude-env-guide.tsx",
			"install.tsx",
		])
			expect(read(page), page).toContain("utilityPageHead(");
		// The root and public layouts apply to content pages: never noindex there.
		for (const shared of ["__root.tsx", "(public)/route.tsx"])
			expect(read(shared), shared).not.toMatch(/utilityPageHead|noindex/);
	});
});
