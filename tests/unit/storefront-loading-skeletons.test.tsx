// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("#/features/auth/auth-client", () => ({
	authClient: { useSession: vi.fn() },
}));

vi.mock("#/features/exchange-rates/currency-context", () => ({
	StoreMoney: () => null,
	useCurrency: () => ({ currency: "USD" }),
}));

vi.mock("#/features/storefront/server/account-functions", () => ({
	getAccountOrderFn: vi.fn(),
}));

vi.mock("#/features/storefront/server/cart", () => ({
	getStoreCartFn: vi.fn(),
	previewStoreCartFn: vi.fn(),
	removeStoreCartItemFn: vi.fn(),
	setStoreCartItemFn: vi.fn(),
	syncStoreCartFn: vi.fn(),
}));

vi.mock("#/features/storefront/server/catalog", () => ({
	getStorefrontProductFn: vi.fn(),
	listStorefrontCatalogFn: vi.fn(),
}));

vi.mock("#/features/storefront/server/functions", () => ({
	checkoutStoreOrderFn: vi.fn(),
	getStoreOrderFn: vi.fn(),
	listCheckoutPaymentChannelsFn: vi.fn(),
	retryStorePaymentFn: vi.fn(),
}));

vi.mock("#/features/wallet/server/functions", () => ({
	getWalletFn: vi.fn(),
}));

import { ProductGridSkeleton } from "#/features/home";
import { CartLoadingSkeleton } from "#/features/storefront/pages/cart";
import { CheckoutLoadingSkeleton } from "#/features/storefront/pages/checkout";
import { OrderLoadingSkeleton } from "#/features/storefront/pages/order";
import { ProductLoadingSkeleton } from "#/features/storefront/pages/product";

describe("storefront loading skeletons", () => {
	it.each([
		["cart", () => <CartLoadingSkeleton />],
		["checkout", () => <CheckoutLoadingSkeleton />],
		["order", () => <OrderLoadingSkeleton />],
		["product", () => <ProductLoadingSkeleton />],
	])("renders %s loading state as accessible skeleton geometry", (_, view) => {
		const document = new DOMParser().parseFromString(
			renderToStaticMarkup(view()),
			"text/html",
		);
		const status = document.querySelector('[aria-busy="true"]');

		expect(status?.getAttribute("aria-busy")).toBe("true");
		expect(status?.getAttribute("aria-label")).toBeTruthy();
		expect(
			status?.querySelectorAll('[data-slot="skeleton"]').length,
		).toBeGreaterThan(3);
		expect(status?.textContent?.trim()).toBe("");
	});

	it("keeps the catalog skeleton on the exact product-card grid", () => {
		const document = new DOMParser().parseFromString(
			renderToStaticMarkup(<ProductGridSkeleton />),
			"text/html",
		);
		const grid = document.querySelector(
			'[data-skeleton-layout="product-grid"]',
		);

		expect(grid?.className).toContain(
			"sm:grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))]",
		);
		expect(grid?.querySelectorAll("article")).toHaveLength(8);
	});

	it("matches the detail gallery and purchase geometry", () => {
		const document = new DOMParser().parseFromString(
			renderToStaticMarkup(<ProductLoadingSkeleton />),
			"text/html",
		);
		const detail = document.querySelector(
			'[data-skeleton-layout="product-detail"]',
		);
		const gallery = detail?.querySelector(
			'[data-skeleton-region="product-gallery"]',
		);
		const thumbnails = detail?.querySelector(
			'[data-skeleton-region="product-thumbnails"]',
		);
		const purchase = detail?.querySelector(
			'[data-skeleton-region="product-purchase"]',
		);
		const plans = detail?.querySelector(
			'[data-skeleton-region="product-plans"]',
		);

		expect(detail?.className).toContain("container px-4 py-7 sm:py-10");
		expect(gallery?.className).toContain("grid content-start gap-3");
		expect(
			gallery?.querySelector('[data-slot="skeleton"].aspect-video.rounded-2xl'),
		).not.toBeNull();
		expect(thumbnails?.className).toContain("grid-cols-5 gap-2");
		expect(thumbnails?.children).toHaveLength(5);
		expect(purchase?.className).toContain(
			"min-w-0 lg:sticky lg:top-26 lg:h-fit",
		);
		expect(plans?.className).toContain(
			"grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))]",
		);
		expect(plans?.children).toHaveLength(2);
	});

	it("matches cart and checkout item counts and split layouts", () => {
		const cart = new DOMParser().parseFromString(
			renderToStaticMarkup(<CartLoadingSkeleton itemCount={3} />),
			"text/html",
		);
		const checkout = new DOMParser().parseFromString(
			renderToStaticMarkup(<CheckoutLoadingSkeleton itemCount={3} />),
			"text/html",
		);

		expect(
			cart.querySelector('[data-skeleton-layout="cart"]')?.className,
		).toContain("lg:grid-cols-[minmax(0,1fr)_21rem]");
		expect(cart.querySelectorAll('[data-skeleton-item="cart"]')).toHaveLength(
			3,
		);
		expect(
			checkout.querySelector('[data-skeleton-region="checkout-form"]')
				?.className,
		).toContain("lg:grid-cols-2");
		expect(
			checkout.querySelectorAll('[data-skeleton-item="checkout"]'),
		).toHaveLength(3);
	});

	it("matches the order detail split card and payment region", () => {
		const document = new DOMParser().parseFromString(
			renderToStaticMarkup(<OrderLoadingSkeleton />),
			"text/html",
		);
		const order = document.querySelector('[data-skeleton-layout="order"]');

		expect(order?.className).toContain("container px-4 py-8 sm:py-12");
		expect(
			order?.querySelector('[data-skeleton-region="order-card"]')?.className,
		).toContain("lg:grid-cols-2");
		expect(order?.querySelector("aside")?.className).toContain("bg-muted/35");
		expect(
			order?.querySelector('aside [data-slot="skeleton"].size-56'),
		).not.toBeNull();
	});
});
