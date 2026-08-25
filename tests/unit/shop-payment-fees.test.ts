import { describe, expect, it } from "vitest";
import {
	grossUpPaymentAmount,
	paymentSurchargeAmount,
} from "#/features/shop-payments/fees";

describe("payment channel fees", () => {
	it("grosses up a 3 percent channel so the order value remains covered", () => {
		expect(grossUpPaymentAmount("10000", 300, "0")).toBe("10310");
		expect(paymentSurchargeAmount("10000", 300, "0")).toBe("310");
	});

	it("rounds the payable amount upward in minor units", () => {
		expect(grossUpPaymentAmount("1990", 300, "0")).toBe("2052");
		expect(paymentSurchargeAmount("1990", 300, "0")).toBe("62");
	});
});
