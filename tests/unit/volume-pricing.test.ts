import { describe, expect, it } from "vitest";
import { resolveUnitPrice } from "#/features/storefront/volume-pricing";

// ChatGPT Plus｜菲区: USDT 119 (base), 支付宝 125; public steps 10/30/40/50 take 1/2/3/4 off.
const plus = {
	basePriceMinor: "11900",
	volumeSteps: [
		{ minQuantity: 10, discountMinor: "100" },
		{ minQuantity: 30, discountMinor: "200" },
		{ minQuantity: 40, discountMinor: "300" },
		{ minQuantity: 50, discountMinor: "400" },
	],
	customerSteps: [],
};
const usdt = { listPriceMinor: "11900", channelId: "usdt" };
const alipay = { listPriceMinor: "12500", channelId: "alipay" };

describe("volume pricing", () => {
	it("keeps the list price below the first step", () => {
		expect(resolveUnitPrice({ ...plus, ...usdt, quantity: 9 })).toEqual({
			unitPriceMinor: "11900",
			source: "list",
		});
	});

	it("takes the deepest step's discount off each channel's own price", () => {
		const at = (quantity: number, channel = usdt) =>
			resolveUnitPrice({ ...plus, ...channel, quantity }).unitPriceMinor;
		expect(
			[10, 29, 30, 39, 40, 49, 50].map((quantity) => at(quantity)),
		).toEqual(["11800", "11800", "11700", "11700", "11600", "11600", "11500"]);
		expect([10, 30, 40, 50].map((quantity) => at(quantity, alipay))).toEqual([
			"12400",
			"12300",
			"12200",
			"12100",
		]);
		expect(resolveUnitPrice({ ...plus, ...usdt, quantity: 50 }).source).toBe(
			"volume",
		);
	});

	it("ignores a discount that would make the price zero or negative", () => {
		expect(
			resolveUnitPrice({
				...plus,
				...usdt,
				volumeSteps: [{ minQuantity: 2, discountMinor: "11900" }],
				quantity: 2,
			}).unitPriceMinor,
		).toBe("11900");
	});
});

describe("customer prices", () => {
	it("charges the agreed base price and adds the channel's usual difference", () => {
		const customerSteps = [
			{ minQuantity: 1, priceMinor: "11500", channelPrices: {} },
		];
		expect(
			resolveUnitPrice({ ...plus, ...usdt, customerSteps, quantity: 1 }),
		).toEqual({ unitPriceMinor: "11500", source: "customer" });
		expect(
			resolveUnitPrice({ ...plus, ...alipay, customerSteps, quantity: 1 })
				.unitPriceMinor,
		).toBe("12100");
		// No channel (account balance) pays the base price.
		expect(
			resolveUnitPrice({
				...plus,
				listPriceMinor: "11900",
				channelId: null,
				customerSteps,
				quantity: 1,
			}).unitPriceMinor,
		).toBe("11500");
	});

	it("uses a price named for the channel instead of the difference", () => {
		const customerSteps = [
			{
				minQuantity: 1,
				priceMinor: "11500",
				channelPrices: { alipay: "11900" },
			},
		];
		expect(
			resolveUnitPrice({ ...plus, ...alipay, customerSteps, quantity: 1 })
				.unitPriceMinor,
		).toBe("11900");
	});

	it("applies a customer step only from its quantity and keeps the lowest price", () => {
		const customerSteps = [
			{ minQuantity: 10, priceMinor: "11300", channelPrices: {} },
		];
		expect(
			resolveUnitPrice({ ...plus, ...usdt, customerSteps, quantity: 9 }),
		).toEqual({ unitPriceMinor: "11900", source: "list" });
		expect(
			resolveUnitPrice({ ...plus, ...usdt, customerSteps, quantity: 10 }),
		).toEqual({ unitPriceMinor: "11300", source: "customer" });
		// At 50 the public step (115) beats a customer price of 116.
		expect(
			resolveUnitPrice({
				...plus,
				...usdt,
				customerSteps: [
					{ minQuantity: 1, priceMinor: "11600", channelPrices: {} },
				],
				quantity: 50,
			}),
		).toEqual({ unitPriceMinor: "11500", source: "volume" });
	});
});
