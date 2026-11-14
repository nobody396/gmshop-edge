import { describe, expect, it } from "vitest";
import { purchaseMaximum } from "#/features/storefront/product-quantity";
import { STOCK_BAND_THRESHOLDS, stockBand } from "#/features/storefront/stock-band";

describe("storefront product quantity", () => {
	it("uses the configured maximum for delivery without finite stock", () => {
		expect(
			purchaseMaximum({ stockBand: "unlimited", maximumQuantity: 8 }),
		).toBe(8);
		expect(purchaseMaximum({ stockBand: "plenty", maximumQuantity: 50 })).toBe(
			50,
		);
	});

	it("caps the picker at the band ceiling so it never reveals the count", () => {
		expect(purchaseMaximum({ stockBand: "low", maximumQuantity: 8 })).toBe(4);
		expect(purchaseMaximum({ stockBand: "limited", maximumQuantity: 50 })).toBe(
			19,
		);
		expect(purchaseMaximum({ stockBand: "limited", maximumQuantity: 8 })).toBe(
			8,
		);
		expect(purchaseMaximum({ stockBand: "out", maximumQuantity: 8 })).toBe(0);
	});
});

describe("stock bands", () => {
	it("maps counts to the owner's bands", () => {
		expect(STOCK_BAND_THRESHOLDS).toEqual({ plenty: 20, limited: 5 });
		expect(stockBand(-1)).toBe("unlimited");
		expect(stockBand(0)).toBe("out");
		expect(stockBand(1)).toBe("low");
		expect(stockBand(4)).toBe("low");
		expect(stockBand(5)).toBe("limited");
		expect(stockBand(19)).toBe("limited");
		expect(stockBand(20)).toBe("plenty");
		expect(stockBand(200)).toBe("plenty");
	});

	it("treats stock below the minimum order as sold out", () => {
		expect(stockBand(3, 5)).toBe("out");
		expect(stockBand(5, 5)).toBe("limited");
	});
});
