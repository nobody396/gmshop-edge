import type { PropsWithChildren } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: PropsWithChildren) => <a href="/test">{children}</a>,
}));
vi.mock("#/features/exchange-rates/currency-context", () => ({
	useCurrency: () => ({ format: () => "¥199.00" }),
}));
vi.mock("#/paraglide/messages", () => ({
	m: new Proxy(
		{},
		{
			get: (_, key) => (input?: { count: number }) =>
				key === "store_stock" ? `Stock ${input?.count}` : String(key),
		},
	),
}));

import {
	type StorefrontCatalogProduct,
	StorefrontProductCard,
} from "#/features/storefront/components/product-card";

const product: StorefrontCatalogProduct = {
	id: "access",
	name: "Access",
	description: "One-time",
	productType: "automation",
	saleDisabled: false,
	tags: [],
	coverUrl: null,
	sellableItemId: "access-sku",
	priceMinor: "19900",
	maxPriceMinor: "19900",
	listPriceMinor: null,
	currency: "CNY",
	currencyDecimals: 2,
	availableStock: -1,
	displayStockQuantity: -1,
	hasManualFulfillment: false,
	hasAutomaticFulfillment: true,
	salesCount: 0,
	deliveryTypes: ["automation"],
};
describe("access product inventory sentinel", () => {
	it("never displays negative stock for a non-stock access product", () => {
		const html = renderToStaticMarkup(
			<StorefrontProductCard product={product} />,
		);
		expect(html).not.toContain("Stock -1");
		expect(html).toContain("¥199.00");
	});
	it("preserves normal product stock counts", () => {
		const html = renderToStaticMarkup(
			<StorefrontProductCard
				product={{ ...product, productType: "stock", displayStockQuantity: 5 }}
			/>,
		);
		expect(html).toContain("Stock 5");
	});
	it("preserves sold-out products", () => {
		const html = renderToStaticMarkup(
			<StorefrontProductCard
				product={{ ...product, productType: "stock", displayStockQuantity: 0 }}
			/>,
		);
		expect(html).toContain("store_sold_out");
	});
});
