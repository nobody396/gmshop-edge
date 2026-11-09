import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	checkoutSearchSchema,
	initialPaymentChannelId,
} from "#/features/storefront/schema";

const checkoutPageSource = readFileSync(
	new URL("../../src/features/storefront/pages/checkout.tsx", import.meta.url),
	"utf8",
);

describe("checkout search parameters", () => {
	it("parses a buy-now deep link without relying on browser-only state", () => {
		expect(
			checkoutSearchSchema.parse({
				mode: "buy-now",
				sellableItemId: "260f86cb-d2d2-4c3d-9bb9-4a5dc2b5086e",
				quantity: "2",
			}),
		).toEqual({
			mode: "buy-now",
			sellableItemId: "260f86cb-d2d2-4c3d-9bb9-4a5dc2b5086e",
			quantity: 2,
		});
	});

	it("defaults quantity to one", () => {
		expect(
			checkoutSearchSchema.parse({
				mode: "buy-now",
				sellableItemId: "260f86cb-d2d2-4c3d-9bb9-4a5dc2b5086e",
			}).quantity,
		).toBe(1);
	});

	it("rejects malformed sellable-item ids and unsafe quantities", () => {
		expect(() =>
			checkoutSearchSchema.parse({
				mode: "buy-now",
				sellableItemId: "not-an-id",
				quantity: 1,
			}),
		).toThrow();
		expect(() =>
			checkoutSearchSchema.parse({
				mode: "buy-now",
				sellableItemId: "260f86cb-d2d2-4c3d-9bb9-4a5dc2b5086e",
				quantity: 0,
			}),
		).toThrow();
	});
});

describe("checkout payment preselection", () => {
	const itemId = "260f86cb-d2d2-4c3d-9bb9-4a5dc2b5086e";
	const channels = [{ id: "usdt" }, { id: "alipay-main" }];

	it("keeps the payment method picked on the product page", () => {
		const search = checkoutSearchSchema.parse({
			mode: "buy-now",
			sellableItemId: itemId,
			payment: "alipay-main",
		});
		expect(search.payment).toBe("alipay-main");
		expect(initialPaymentChannelId(channels, search.payment)).toBe(
			"alipay-main",
		);
	});

	it("drops malformed values instead of breaking old or tampered links", () => {
		for (const payment of ["", "<script>", "a".repeat(65), 42, ["x"]])
			expect(
				checkoutSearchSchema.parse({
					mode: "buy-now",
					sellableItemId: itemId,
					payment,
				}).payment,
			).toBeUndefined();
		expect(
			checkoutSearchSchema.parse({ mode: "buy-now", sellableItemId: itemId }),
		).toEqual({ mode: "buy-now", sellableItemId: itemId, quantity: 1 });
	});

	it("falls back to the first offered method for unknown or missing ids", () => {
		expect(initialPaymentChannelId(channels, "retired-channel")).toBe("usdt");
		expect(initialPaymentChannelId(channels, undefined)).toBe("usdt");
		expect(initialPaymentChannelId([], "usdt")).toBeUndefined();
	});

	it("is wired into checkout", () => {
		expect(checkoutPageSource).toContain(
			"initialPaymentChannelId(channels.data ?? [], search.payment)",
		);
	});
});

describe("checkout presentation", () => {
	it("keeps checkout in one responsive two-column surface", () => {
		expect(checkoutPageSource).toContain(
			"grid overflow-hidden rounded-3xl border bg-card shadow-sm lg:grid-cols-2",
		);
		expect(checkoutPageSource).toContain("lg:border-t-0 lg:border-l lg:p-10");
	});

	it("presents each payment method as a full-width card with its own price", () => {
		expect(checkoutPageSource).toContain(
			"group flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border",
		);
		expect(checkoutPageSource).toContain('className="sr-only"');
		expect(checkoutPageSource).toContain("has-checked:bg-primary/5");
		expect(checkoutPageSource).toContain("m.store_checkout_amount_due()");
		expect(checkoutPageSource).not.toContain(
			"grid-cols-[repeat(auto-fill,minmax(7.5rem,10rem))]",
		);
	});

	it("says what happens after submitting and keeps submit reachable on phones", () => {
		expect(checkoutPageSource).toContain("m.store_checkout_next_step()");
		expect(checkoutPageSource).toContain("useSubmitBelowFold(submitButton)");
		expect(checkoutPageSource).toContain("fixed inset-x-0 bottom-0 z-40");
		// The purchase terms stay pre-checked.
		expect(checkoutPageSource).toContain(
			"const [termsAccepted, setTermsAccepted] = useState(true);",
		);
	});

	it("keeps order-item thumbnails compact", () => {
		expect(checkoutPageSource).toContain(
			"aspect-video w-18 shrink-0 rounded-md object-cover",
		);
		expect(checkoutPageSource).not.toContain(
			"aspect-video w-18 shrink-0 rounded-2xl",
		);
	});

	it("redirects GMPay orders straight to the network-selection cashier", () => {
		expect(checkoutPageSource).toContain('selectedProvider === "gmpay"');
		expect(checkoutPageSource).toContain(
			"window.location.assign(hostedCheckoutUrl)",
		);
	});

	it("formats the combined spending balance as money instead of exposing minor units", () => {
		expect(checkoutPageSource).toContain(
			"amountMinor={balanceAvailable.toString()}",
		);
		expect(checkoutPageSource).toContain("currency={wallet.data.currency}");
		expect(checkoutPageSource).toContain(
			"decimals={wallet.data.currencyDecimals}",
		);
		expect(checkoutPageSource).not.toContain(
			"{m.wallet_balance()}: {wallet.data.balanceMinor}",
		);
	});
});
