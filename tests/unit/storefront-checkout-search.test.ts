import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkoutSearchSchema } from "#/features/storefront/schema";

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

describe("checkout presentation", () => {
	it("keeps checkout in one responsive two-column surface", () => {
		expect(checkoutPageSource).toContain(
			"grid overflow-hidden rounded-3xl border bg-card shadow-sm lg:grid-cols-2",
		);
		expect(checkoutPageSource).toContain("lg:border-t-0 lg:border-l lg:p-10");
	});

	it("presents payment methods like selectable plans without a visible radio", () => {
		expect(checkoutPageSource).toContain(
			"grid grid-cols-[repeat(auto-fill,minmax(7.5rem,10rem))] gap-3",
		);
		expect(checkoutPageSource).toContain('className="sr-only"');
		expect(checkoutPageSource).toContain("has-checked:bg-primary/10");
		expect(checkoutPageSource).toContain(
			"grid min-h-16 cursor-pointer place-items-center content-center gap-1.5 rounded-lg",
		);
		expect(checkoutPageSource).not.toContain(
			'name="payment-channel"\n\t\t\t\t\t\t\t\t\t\tclassName="size-4',
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
});
