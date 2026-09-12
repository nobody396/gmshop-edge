import { describe, expect, it } from "vitest";
import {
	paymentChannelIsVisible,
	requestIsFromMainlandChina,
} from "#/features/storefront/server/payment-region";

function requestFrom(country?: string) {
	return Object.assign(new Request("https://laoshirenvip.com"), {
		cf: country ? { country } : undefined,
	});
}

describe("storefront payment region", () => {
	it("shows only Alipay-compatible channels in mainland China", () => {
		const request = requestFrom("CN");

		expect(requestIsFromMainlandChina(request)).toBe(true);
		expect(paymentChannelIsVisible(request, { provider: "epay" })).toBe(true);
		expect(paymentChannelIsVisible(request, { provider: "alipay_page" })).toBe(
			true,
		);
		expect(paymentChannelIsVisible(request, { provider: "gmpay" })).toBe(false);
		expect(paymentChannelIsVisible(request, { provider: "stripe" })).toBe(
			false,
		);
	});

	it("shows Alipay and USDT channels outside mainland China", () => {
		const request = requestFrom("US");

		expect(requestIsFromMainlandChina(request)).toBe(false);
		expect(paymentChannelIsVisible(request, { provider: "epay" })).toBe(true);
		expect(paymentChannelIsVisible(request, { provider: "gmpay" })).toBe(true);
	});

	it("keeps the full channel list when Cloudflare geo data is unavailable", () => {
		const request = requestFrom();

		expect(paymentChannelIsVisible(request, { provider: "epay" })).toBe(true);
		expect(paymentChannelIsVisible(request, { provider: "gmpay" })).toBe(true);
	});
});
