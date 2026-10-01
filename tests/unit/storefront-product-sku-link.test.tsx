// @vitest-environment jsdom

import { act, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	items: [
		{ id: "go", name: "Go", availableStock: 10, minimumQuantity: 1 },
		{ id: "ios", name: "iOS 20X", availableStock: 50, minimumQuantity: 1 },
		{ id: "500", name: "Pro 500", availableStock: 50, minimumQuantity: 2 },
	],
	addToCart: vi.fn(() => true),
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey }: { queryKey: string[] }) => ({
		isLoading: false,
		data:
			queryKey[1] === "product"
				? {
						id: "product",
						name: "ChatGPT",
						productType: "stock",
						tags: [],
						media: [],
						description: "",
						saleDisabled: false,
						sellableItems: mocks.items.map((item) => ({
							...item,
							maximumQuantity: 10,
							priceMinor: "150000",
							currency: "CNY",
							currencyDecimals: 2,
							channelPrices: [],
							deliveryType: "stock",
							fulfillmentSource: "local",
							policy: {},
						})),
					}
				: { products: [] },
	}),
}));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to }: PropsWithChildren<{ to: string }>) => (
		<a href={to}>{children}</a>
	),
}));
vi.mock("#/features/auth/auth-client", () => ({
	authClient: { useSession: () => ({ data: null, isPending: false }) },
}));
vi.mock("#/features/exchange-rates/currency-context", () => ({
	StoreMoney: () => null,
}));
vi.mock("#/features/storefront/server/catalog", () => ({
	getStorefrontProductFn: vi.fn(),
	listStorefrontCatalogFn: vi.fn(),
}));
vi.mock("#/features/storefront/cart-storage", () => ({
	addLocalCartItem: mocks.addToCart,
}));
vi.mock("#/features/storefront/commerce-events", () => ({
	trackCommerceEvent: vi.fn(),
}));
vi.mock("#/paraglide/runtime", () => ({ getLocale: () => "en-US" }));
vi.mock("#/paraglide/messages", () => ({
	m: new Proxy({}, { get: (_, key) => () => String(key) }),
}));

import { StorefrontProductPage } from "#/features/storefront/pages/product";

describe("product SKU deep links", () => {
	let root: Root;
	let container: HTMLDivElement;
	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		vi.clearAllMocks();
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
	});
	function open(item?: string) {
		act(() =>
			root.render(
				<StorefrontProductPage
					key={item ?? "default"}
					productId="product"
					preferredItemId={item}
				/>,
			),
		);
	}
	function button(text: string) {
		const result = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes(text),
		);
		if (!result) throw new Error(`Missing button: ${text}`);
		return result;
	}
	it.each([
		"ios",
		"500",
	])("opens the exact %s SKU, including minimum quantity", (id) => {
		open(id);
		expect(
			container.querySelector('[aria-pressed="true"]')?.textContent,
		).toContain(id === "ios" ? "iOS 20X" : "Pro 500");
		act(() => button("store_add_to_cart").click());
		expect(mocks.addToCart).toHaveBeenCalledWith(id, id === "500" ? 2 : 1, 10);
	});
	it("keeps ordinary product links and manual switching working", () => {
		open();
		expect(
			container.querySelector('[aria-pressed="true"]')?.textContent,
		).toContain("Go");
		act(() => button("Pro 500").click());
		expect(
			container.querySelector('[aria-pressed="true"]')?.textContent,
		).toContain("Pro 500");
	});
	it("does not silently select another SKU for an unknown valid link", () => {
		open("missing");
		expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
		expect(button("store_buy_now").disabled).toBe(true);
	});
	it("resets selection when navigating between SKU links on the same product", () => {
		open("ios");
		open("500");
		expect(
			container.querySelector('[aria-pressed="true"]')?.textContent,
		).toContain("Pro 500");
	});
});
