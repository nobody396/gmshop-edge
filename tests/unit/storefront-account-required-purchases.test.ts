import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
	readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("storefront account-required purchase guidance", () => {
	it("shows the shared Alipay fee notice on every product page", () => {
		const product = source("src/features/storefront/pages/product.tsx");

		expect(product).toContain("m.store_alipay_fee_notice()");
		expect(product).toContain("BadgePercent");
		expect(product).toContain("sellableItem.channelPrices.length > 1");
		expect(product).toContain("m.store_payment_prices_title()");
	});

	it("highlights the Claude iOS channel and warranty boundary", () => {
		const product = source("src/features/storefront/pages/product.tsx");

		expect(product).toContain("data.id === claudeRechargeProductId");
		expect(product).toContain("m.store_claude_channel_notice()");
	});

	it("shows SKU-aware automatic and manual usage guides", () => {
		const product = source("src/features/storefront/pages/product.tsx");

		expect(product).toContain("<UsageGuide");
		expect(product).toContain('sellableItem.fulfillmentSource === "supplier"');
		expect(product).toContain("m.store_usage_guide_auto_intro()");
		expect(product).toContain("m.store_usage_guide_manual_intro()");
	});

	it("shows synchronized stock on product and SKU cards", () => {
		const product = source("src/features/storefront/pages/product.tsx");
		const card = source("src/features/storefront/components/product-card.tsx");
		const catalog = source("src/features/storefront/server/catalog.ts");

		expect(product).toContain("m.store_stock({ count: item.availableStock })");
		expect(card).toContain("product.syncedStockQuantity");
		expect(catalog).toContain("AS synced_stock_quantity");
		expect(card).not.toContain("m.store_sales(");
	});

	it("marks every SKU with a slim automatic or manual ribbon", () => {
		const product = source("src/features/storefront/pages/product.tsx");

		expect(product).toContain("-rotate-[32deg]");
		expect(product).toContain("m.store_manual_procurement()");
		expect(product).toContain("m.store_local_delivery()");
	});

	it("keeps the single current Grok SKU in an extensible purchase-options grid", () => {
		const product = source("src/features/storefront/pages/product.tsx");

		expect(product).toContain(
			'data.id === "a48aeca2-90bf-4adf-8cfa-f18204373435"',
		);
		expect(product).toContain("{showPurchaseOptions ? (");
	});

	it("labels supplier-backed delivery as automatic top-up", () => {
		const product = source("src/features/storefront/pages/product.tsx");

		expect(product).toContain('sellableItem.fulfillmentSource === "supplier"');
		expect(product).toContain("m.store_auto_delivery()");
		expect(product).toContain("m.store_supplier_delivery_time()");
	});

	it("guides guests to sign in from automation product purchases", () => {
		const product = source("src/features/storefront/pages/product.tsx");

		expect(product).toContain('selectedItem?.deliveryType === "automation"');
		expect(product).toContain("m.store_account_required_description()");
		expect(product).toContain("search={{ redirect: checkoutPath }}");
		expect(product).toContain('to="/sign-in"');
	});

	it("replaces guest checkout actions with a sign-in return path", () => {
		const cart = source("src/features/storefront/pages/cart.tsx");
		const checkout = source("src/features/storefront/pages/checkout.tsx");

		for (const page of [cart, checkout]) {
			expect(page).toContain('item.deliveryType === "automation"');
			expect(page).toContain("m.store_sign_in_to_purchase()");
			expect(page).toContain('to="/sign-in"');
		}
		expect(cart).toContain('search={{ redirect: "/checkout" }}');
		expect(checkout).toContain("signInRequired ||");
		expect(checkout).toContain("search={{ redirect: checkoutPath }}");
	});
});
