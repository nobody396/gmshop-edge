// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	locale: "zh-CN",
	token: "Q".repeat(43),
	state: "open",
	expires: Date.now() + 60_000,
	user: null as { id: string; email: string } | null,
	checkout: vi.fn(async (_input: unknown) => ({
		accountOrder: false,
		order: { orderNumber: "GMTEST1234" },
		payment: null,
	})),
	navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
	useSearch: () => ({ quote: f.token }),
	useNavigate: () => f.navigate,
}));
vi.mock("#/paraglide/runtime", async (original) => ({
	...(await original<typeof import("#/paraglide/runtime")>()),
	getLocale: () => f.locale,
}));
vi.mock("#/features/auth/auth-client", () => ({
	authClient: {
		useSession: () => ({
			data: f.user ? { user: f.user } : null,
			isPending: false,
		}),
	},
}));
vi.mock("#/features/gpt-upgrade/server/functions", () => ({
	getUpgradeQuoteFn: async () => ({
		state: f.state,
		target_label: "ChatGPT Pro 200",
		source_label: "ChatGPT Plus",
		account_hint: "ab***@example.test",
		remaining_days: 16,
		price_minor: "121000",
		currency: "CNY",
		currency_decimals: 2,
		expires_at: f.expires,
	}),
}));
vi.mock("#/features/storefront/server/functions", () => ({
	checkoutStoreOrderFn: f.checkout,
	listCheckoutPaymentChannelsFn: async () => [
		{
			id: "cccc0000-0000-4000-8000-000000000001",
			name: "Stripe",
			provider: "stripe",
			logoUrl: null,
		},
	],
}));

import { UpgradeCheckoutPage } from "#/features/gpt-upgrade/pages/checkout";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
	f.locale = "zh-CN";
	f.state = "open";
	f.expires = Date.now() + 60_000;
	f.user = null;
	f.checkout.mockClear();
	f.navigate.mockClear();
});
afterEach(() => {
	document.documentElement.className = "";
});
async function fixture(run: (node: HTMLDivElement) => Promise<void>) {
	const node = document.createElement("div");
	document.body.appendChild(node);
	const root = createRoot(node);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	try {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<UpgradeCheckoutPage />
				</QueryClientProvider>,
			);
		});
		for (let i = 0; i < 5; i++)
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 15));
			});
		await run(node);
	} finally {
		await act(async () => root.unmount());
		client.clear();
		node.remove();
	}
}
it.each([
	"zh-CN",
	"en-US",
])("renders localized quote and keyboard-selectable payment in %s and submits no client price", async (locale) => {
	f.locale = locale;
	f.user = { id: "fixture-user", email: "buyer@example.test" };
	await fixture(async (node) => {
		expect(node.textContent).toContain("ChatGPT Pro 200");
		expect(node.textContent).toContain("ab***@example.test");
		expect(node.textContent).toContain("1,210.00");
		expect(node.textContent).toContain(
			locale === "zh-CN" ? "报价倒计时" : "Quote expires in",
		);
		expect(
			node.querySelector('input[type="radio"]')?.hasAttribute("required"),
		).toBe(true);
		expect(
			node.querySelector<HTMLInputElement>("#upgrade-email")?.readOnly,
		).toBe(true);
		expect(node.querySelector('input[name="couponCode"]')).toBeNull();
		await act(async () => {
			node
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		expect(f.checkout).toHaveBeenCalledOnce();
		expect(f.checkout.mock.calls[0]?.[0]).toMatchObject({
			data: {
				upgradeQuoteToken: f.token,
				email: "buyer@example.test",
				paymentCurrency: "CNY",
				couponCode: "",
				items: [{ quantity: 1 }],
			},
		});
		expect(f.checkout.mock.calls[0]?.[0]).not.toHaveProperty(
			"data.price_minor",
		);
	});
});
it.each([
	"paid",
	"expired",
])("does not offer checkout for a %s quote", async (state) => {
	f.state = state;
	await fixture(async (node) => {
		expect(node.textContent).toContain("报价已失效，请回兑换站重新查价");
		expect(node.querySelector("form")).toBeNull();
		expect(node.querySelector("a")?.href).toBe(
			"https://redeem.laoshirenvip.com/upgrade",
		);
	});
});
it("requires guest email and removes checkout when the quote expires", async () => {
	await fixture(async (node) => {
		expect(
			node.querySelector<HTMLInputElement>("#upgrade-email")?.required,
		).toBe(true);
	});
	f.expires = Date.now() - 1;
	await fixture(async (node) => {
		expect(node.querySelector("form")).toBeNull();
	});
});
