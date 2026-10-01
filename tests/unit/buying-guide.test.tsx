// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuyingGuide } from "#/features/home/buying-guide";
import { guideProducts } from "#/features/home/buying-guide-rules";

const mock = vi.hoisted(() => ({
	stock: 10,
	disabled: false,
	missing: false,
	calls: vi.fn(),
}));
vi.mock("#/features/storefront/server/catalog", () => ({
	getStorefrontProductFn: async (args: unknown) => {
		mock.calls(args);
		return {
			saleDisabled: false,
			sellableItems: mock.missing
				? []
				: Object.entries(guideProducts).map(([name, ref]) => ({
						id: ref.itemId,
						name,
						priceMinor: "15000",
						currency: "CNY",
						currencyDecimals: 2,
						availableStock: mock.stock,
						minimumQuantity: 1,
						saleDisabled: mock.disabled,
						policy: {
							deliveryTime: "Delivery timing",
							coverage: "Coverage",
							warranty: "Warranty",
							restrictions: "Restrictions",
						},
					})),
		};
	},
}));
vi.mock("#/features/exchange-rates/currency-context", () => ({
	StoreMoney: ({ amountMinor }: { amountMinor: string }) => (
		<span>{amountMinor}</span>
	),
}));
vi.mock("#/paraglide/messages", () => ({
	m: new Proxy({}, { get: (_t, key) => () => String(key) }),
}));
vi.mock("#/paraglide/runtime", () => ({ getLocale: () => "zh-CN" }));
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
function button(text: string) {
	const el = [...document.querySelectorAll("button")].find(
		(e) =>
			e.textContent === text ||
			[...e.querySelectorAll("span")].some((span) => span.textContent === text),
	);
	if (!el) throw Error(`Missing ${text}`);
	return el;
}
async function click(text: string) {
	await act(async () => {
		button(text).click();
	});
}
async function settle() {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 30));
	});
}
beforeEach(async () => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	mock.stock = 10;
	mock.disabled = false;
	mock.missing = false;
	mock.calls.mockClear();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<BuyingGuide />
			</QueryClientProvider>,
		),
	);
	await click("guide_start");
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	client.clear();
});
it("shows only the six retail families and no unknown answer", () => {
	expect(document.body.textContent).toContain("guide_sms");
	expect(document.body.textContent).not.toMatch(/unknown|unsure|guide_api/);
	expect(mock.calls).not.toHaveBeenCalled();
});

it("preserves the user's two annotated images and safe external checking links", async () => {
	await click("guide_gpt");
	expect(
		document
			.querySelector('a[href="https://chatgpt.com/"]')
			?.getAttribute("target"),
	).toBe("_blank");
	expect(
		document.querySelector('img[src="/guides/buying/current-plan.png"]'),
	).not.toBeNull();
	await click("guide_plus");
	expect(document.body.textContent).toContain("guide_current_channel");
	expect(
		document.querySelector('img[src="/guides/buying/billing.png"]'),
	).not.toBeNull();
	expect(
		document.querySelector('a[href="https://chatgpt.com/#settings/Billing"]'),
	).not.toBeNull();
});
it("never exposes a purchase link for the unlisted upgrade and clears it on back", async () => {
	await click("guide_gpt");
	await click("guide_plus");
	await click("guide_current_ph");
	await click("guide_five");
	await click("guide_recharge_now");
	await click("guide_ph_upgrade");
	expect(document.body.textContent).toContain("guide_upgrade_pending");
	expect(document.querySelector('a[href^="/products/"]')).toBeNull();
	expect(mock.calls).not.toHaveBeenCalled();
	await click("guide_back");
	await click("guide_ios");
	await settle();
	expect(document.body.textContent).not.toContain("guide_upgrade_pending");
	expect(document.querySelector('a[href^="/products/"]')).toBeNull();
	await act(async () => {
		(
			document.querySelector('input[type="checkbox"]') as HTMLInputElement
		).click();
	});
	expect(
		document.querySelector('a[href^="/products/"]')?.getAttribute("href"),
	).toContain(`item=${guideProducts.fiveios.itemId}`);
	await click("guide_back");
	await click("guide_ios");
	await settle();
	expect(document.querySelector('a[href^="/products/"]')).toBeNull();
});
it.each([
	{ stock: 0, disabled: false, missing: false, label: "guide_sold_out" },
	{ stock: 10, disabled: true, missing: false, label: "guide_unavailable" },
	{ stock: 10, disabled: false, missing: true, label: "guide_unavailable" },
])("blocks buying when $label", async (state) => {
	Object.assign(mock, state);
	await click("guide_sms");
	await click("guide_smsone");
	await settle();
	expect(document.body.textContent).toContain(state.label);
	expect(document.querySelector('a[href^="/products/"]')).toBeNull();
});
it("does not auto-select a different in-stock product and targets the exact requested SKU", async () => {
	await click("guide_sms");
	await click("guide_smslong");
	await settle();
	expect(
		document.querySelector('a[href^="/products/"]')?.getAttribute("href"),
	).toBe(
		`/products/${guideProducts.smslong.productId}?item=${guideProducts.smslong.itemId}#purchase-options`,
	);
});
it("blocks Free points and closes/reopens at the start", async () => {
	await click("guide_points");
	await click("guide_free");
	expect(document.body.textContent).toContain("guide_free_points");
	await click("common_close");
	await click("guide_start");
	expect(document.body.textContent).toContain("guide_family");
	expect(mock.calls).not.toHaveBeenCalled();
});

it("enlarges both examples in a nested dialog and preserves the guide step", async () => {
	await click("guide_gpt");
	const openImage = async () => {
		const summary = document.querySelector("summary");
		await act(async () => {
			summary?.click();
		});
		await click("guide_enlarge");
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
		expect(document.querySelector('a[href^="/guides/"]')).toBeNull();
		await click("guide_image_original");
		expect(
			document.querySelectorAll('[role="dialog"]')[1]?.querySelector("img")
				?.className,
		).toContain("max-w-none");
		await act(async () => {
			[...document.querySelectorAll("button")]
				.filter((b) => b.textContent === "common_close")
				.at(-1)
				?.click();
		});
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
	};
	await openImage();
	expect(document.body.textContent).toContain("guide_gpt_current");
	await click("guide_plus");
	await openImage();
	expect(document.body.textContent).toContain("guide_current_channel");
	await click("guide_current_ph");
	await click("guide_five");
	await click("guide_recharge_now");
	await click("guide_ph_upgrade");
	expect(document.body.textContent).toContain("guide_upgrade_pending");
});

it("opens $200 without qualification and uses the exact free-account SKU", async () => {
	await click("guide_gpt");
	await click("guide_free");
	await click("guide_twenty");
	expect(document.body.textContent).toContain("guide_channel");
	expect(document.querySelector('a[href^="/products/"]')).toBeNull();
	await click("guide_ph");
	await settle();
	expect(document.body.textContent).not.toMatch(
		/guide_new20|guide_eligib|guide_ineligible/,
	);
	expect(
		document.querySelector('a[href^="/products/"]')?.getAttribute("href"),
	).toContain(`item=${guideProducts.twentynew.itemId}`);
});
it("offers the opened $500 tier with delivery timing and an exact SKU link", async () => {
	await click("guide_gpt");
	await click("guide_free");
	await click("guide_fivehundred");
	await settle();
	expect(document.body.textContent).toContain("Delivery timing");
	expect(
		document.querySelector('a[href^="/products/"]')?.getAttribute("href"),
	).toContain(`item=${guideProducts.gpt500.itemId}`);
});
it("does not recommend $500 to an active subscriber", async () => {
	await click("guide_gpt");
	await click("guide_plus");
	await click("guide_current_ph");
	await click("guide_fivehundred");
	await click("guide_recharge_now");
	expect(document.body.textContent).toContain("guide_fivehundred_active");
	expect(document.querySelector('a[href^="/products/"]')).toBeNull();
	expect(mock.calls).not.toHaveBeenCalled();
});

it("does not turn Plus renewal into iOS until the user explicitly chooses now", async () => {
	await click("guide_gpt");
	await click("guide_plus");
	await click("guide_current_ph");
	await click("guide_plus");
	expect(document.body.textContent).toContain("guide_timing");
	expect(mock.calls).not.toHaveBeenCalled();
	await click("guide_after_expiry");
	expect(document.body.textContent).toContain("guide_wait_for_expiry");
	expect(document.querySelector('a[href^="/products/"]')).toBeNull();
	expect(mock.calls).not.toHaveBeenCalled();
	await click("guide_back");
	await click("guide_recharge_now");
	await settle();
	expect(document.body.textContent).toContain("plusios");
	expect(document.querySelector('a[href^="/products/"]')).toBeNull();
	await act(async () => {
		(
			document.querySelector('input[type="checkbox"]') as HTMLInputElement
		).click();
	});
	expect(
		document.querySelector('a[href^="/products/"]')?.getAttribute("href"),
	).toContain(`item=${guideProducts.plusios.itemId}`);
});
it("lets a Free account switch Plus channels without default selection", async () => {
	await click("guide_gpt");
	await click("guide_free");
	await click("guide_plus");
	expect(mock.calls).not.toHaveBeenCalled();
	await click("guide_ph");
	await settle();
	expect(
		document.querySelector('a[href^="/products/"]')?.getAttribute("href"),
	).toContain(`item=${guideProducts.plusph.itemId}`);
	await click("guide_back");
	await click("guide_ios");
	await settle();
	expect(
		document.querySelector('a[href^="/products/"]')?.getAttribute("href"),
	).toContain(`item=${guideProducts.plusios.itemId}`);
});

it("routes a current PH Pro $200 account to dedicated renewal, not iOS", async () => {
	await click("guide_gpt");
	await click("guide_pro200");
	expect(document.body.textContent).toContain("guide_current_channel");
	expect(mock.calls).not.toHaveBeenCalled();
	await click("guide_current_ph");
	await click("guide_twenty");
	await click("guide_recharge_now");
	expect(document.body.textContent).toContain("guide_pro_php");
	await click("guide_yes_8919");
	await click("guide_ph_renew");
	await settle();
	expect(
		document.querySelector('a[href^="/products/"]')?.getAttribute("href"),
	).toContain(`item=${guideProducts.twentyrenew.itemId}`);
	expect(document.querySelector('input[type="checkbox"]')).toBeNull();
	expect(document.body.textContent).not.toContain("gpt20ios");
	await click("guide_back");
	await click("guide_back");
	await click("guide_no_8919");
	expect(document.body.textContent).toContain("guide_renew_bill_mismatch");
	expect(document.querySelector('a[href^="/products/"]')).toBeNull();
});
it("routes a current iOS Pro $200 account to iOS only", async () => {
	await click("guide_gpt");
	await click("guide_pro200");
	await click("guide_current_ios");
	await click("guide_twenty");
	await click("guide_recharge_now");
	await settle();
	expect(document.body.textContent).toContain("gpt20ios");
	expect(document.body.textContent).not.toMatch(
		/guide_pro_php|twentyrenew|guide_renew_channel/,
	);
	expect(document.querySelector('a[href^="/products/"]')).toBeNull();
	await act(async () => {
		(
			document.querySelector('input[type="checkbox"]') as HTMLInputElement
		).click();
	});
	expect(
		document.querySelector('a[href^="/products/"]')?.getAttribute("href"),
	).toContain(`item=${guideProducts.gpt20ios.itemId}`);
});
