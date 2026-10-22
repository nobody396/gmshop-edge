// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VolumePriceTable } from "#/features/storefront/components/volume-price-table";
import { overwriteGetLocale } from "#/paraglide/runtime";

vi.mock("#/features/exchange-rates/currency-context", () => ({
	StoreMoney: ({ amountMinor }: { amountMinor: string }) =>
		`¥${(Number(amountMinor) / 100).toFixed(2)}`,
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	overwriteGetLocale(() => "zh-CN");
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

const usdt = { id: "usdt", name: "USDT", priceMinor: "11900" };
const alipay = { id: "alipay", name: "支付宝", priceMinor: "12500" };
const plus = {
	priceMinor: "11900",
	currency: "CNY",
	currencyDecimals: 2,
	maximumQuantity: 50,
	channelPrices: [usdt, alipay],
};
const plusSteps = {
	volumeSteps: [
		{ minQuantity: 10, discountMinor: "100" },
		{ minQuantity: 30, discountMinor: "200" },
		{ minQuantity: 40, discountMinor: "300" },
		{ minQuantity: 50, discountMinor: "400" },
	],
	customerSteps: [],
};
const rows = () =>
	[...container.querySelectorAll("tbody tr")].map((row) =>
		row.textContent?.replace(/\s+/g, ""),
	);

it("lists only discounted quantities, starting from the first step", async () => {
	await act(async () =>
		root.render(
			<VolumePriceTable item={plus} pricing={plusSteps} quantity={1} />,
		),
	);
	expect(rows()).toEqual([
		"10–29张¥118.00¥124.00",
		"30–39张¥117.00¥123.00",
		"40–49张¥116.00¥122.00",
		"50张起¥115.00¥121.00",
	]);
});

it("shows a single '3 张起' row for a plan with one step", async () => {
	await act(async () =>
		root.render(
			<VolumePriceTable
				item={{ ...plus, priceMinor: "71000", channelPrices: [] }}
				pricing={{
					volumeSteps: [{ minQuantity: 3, discountMinor: "500" }],
					customerSteps: [],
				}}
				quantity={3}
			/>,
		),
	);
	expect(rows()).toEqual(["3张起¥705.00"]);
});

it("never names USDT when the visitor is only offered Alipay (mainland China)", async () => {
	await act(async () =>
		root.render(
			<VolumePriceTable
				item={{ ...plus, channelPrices: [alipay] }}
				pricing={plusSteps}
				quantity={10}
			/>,
		),
	);
	expect(container.textContent).not.toMatch(/USDT/i);
	expect(rows()[0]).toBe("10–29张¥124.00");
});

it("shows a customer's flat price as any quantity", async () => {
	await act(async () =>
		root.render(
			<VolumePriceTable
				item={{ ...plus, channelPrices: [usdt] }}
				pricing={{
					volumeSteps: [],
					customerSteps: [
						{ minQuantity: 1, priceMinor: "11300", channelPrices: {} },
					],
				}}
				quantity={1}
			/>,
		),
	);
	expect(rows()).toEqual(["任意数量¥113.00"]);
	expect(container.textContent).toContain("你的专属价");
});
