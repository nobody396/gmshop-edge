// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type PropsWithChildren } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	balance: "0",
	reward: "0",
	eligibility: "eligible",
	checkout: vi.fn(async (_input: unknown) => ({
		accountOrder: true,
		order: { orderNumber: "local-only" },
		payment: null,
	})),
}));
const itemId = "09900000-0000-4000-8000-000000000002";
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: PropsWithChildren) => <a href="/local">{children}</a>,
	useNavigate: () => vi.fn(),
	useSearch: () => ({
		mode: "buy-now",
		sellableItemId: "09900000-0000-4000-8000-000000000002",
		quantity: 1,
	}),
}));
vi.mock("#/features/auth/auth-client", () => ({
	authClient: {
		useSession: () => ({
			data: {
				user: {
					id: "buyer",
					email: "buyer@customer.test",
					emailVerified: true,
				},
			},
			isPending: false,
		}),
	},
}));
vi.mock("#/features/exchange-rates/currency-context", () => ({
	useCurrency: () => ({ currency: "CNY" }),
	StoreMoney: ({ amountMinor }: { amountMinor: string }) => (
		<span>{amountMinor}</span>
	),
}));
vi.mock("#/features/storefront/cart-storage", () => ({
	useLocalCart: () => ({ items: [] }),
	writeLocalCart: vi.fn(),
}));
vi.mock("#/features/storefront/commerce-events", () => ({
	commerceSessionId: () => "local",
	trackCommerceEvent: vi.fn(),
}));
vi.mock("#/features/promotions/referral-storage", () => ({
	readReferral: () => "",
}));
vi.mock("#/features/storefront/server/cart", () => ({
	getStoreCartFn: vi.fn(),
	previewStoreCartFn: async () => ({
		items: [
			{
				sellableItemId: "09900000-0000-4000-8000-000000000002",
				productId: "09900000-0000-4000-8000-000000000001",
				productName: "API",
				sellableItemName: "Access",
				quantity: 1,
				issues: [],
				priceMinor: "990",
				currency: "CNY",
				currencyDecimals: 2,
				deliveryType: "automation",
			},
		],
	}),
}));
vi.mock("#/features/storefront/server/catalog", () => ({
	getStorefrontProductFn: async () => ({ inputs: [] }),
}));
vi.mock("#/features/storefront/server/functions", () => ({
	checkoutStoreOrderFn: f.checkout,
	quoteCheckoutPaymentChannelsFn: async () => [
		{
			id: "crypto",
			name: "USDT",
			provider: "gmpay",
			feeBps: 0,
			fixedFeeMinor: "0",
			itemPrices: {},
		},
		{
			id: "alipay",
			name: "Alipay",
			provider: "epay",
			feeBps: 160,
			fixedFeeMinor: "0",
			itemPrices: {},
		},
	],
}));
vi.mock("#/features/promotions/server/functions", () => ({
	quotePromotionFn: async () => ({ discountMinor: "0" }),
}));
vi.mock("#/features/wallet/server/functions", () => ({
	getWalletFn: async () => ({
		balanceMinor: f.balance,
		rewardBalanceMinor: f.reward,
		currency: "CNY",
		currencyDecimals: 2,
	}),
}));
vi.mock("#/features/agent-access/server/functions", () => ({
	checkAgentAccessFn: async () => {
		if (f.eligibility === "error") throw new Error("unavailable");
		return { state: f.eligibility, url: "/local" };
	},
	getAgentDeliveryFn: vi.fn(),
	openAgentAccountFn: vi.fn(),
}));
vi.mock("#/features/agent-access/server/admin", () => ({
	listAgentAccessIssuesFn: vi.fn(),
	prepareAgentProductsFn: vi.fn(),
	retryAgentAccessFn: vi.fn(),
}));
vi.mock("#/paraglide/messages", () => ({
	m: new Proxy(
		{},
		{
			get: (_, key) => (params?: { email?: string }) =>
				params?.email ? `${String(key)} ${params.email}` : String(key),
		},
	),
}));
vi.mock("#/paraglide/runtime", () => ({ getLocale: () => "en-US" }));

import { StorefrontCheckoutPage } from "#/features/storefront/pages/checkout";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal(
	"ResizeObserver",
	class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
);
afterEach(() => {
	f.balance = "0";
	f.reward = "0";
	f.eligibility = "eligible";
	f.checkout.mockClear();
});
async function fixture(
	run: (node: HTMLDivElement, client: QueryClient) => Promise<void>,
) {
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
					<StorefrontCheckoutPage />
				</QueryClientProvider>,
			);
		});
		for (let i = 0; i < 5; i++)
			await act(async () => {
				await new Promise((r) => setTimeout(r, 15));
			});
		await run(node, client);
	} finally {
		await act(async () => root.unmount());
		client.clear();
		node.remove();
	}
}
const consent = (node: HTMLElement) =>
	node.querySelector<HTMLElement>('[role="checkbox"]');
const pay = (node: HTMLElement) =>
	Array.from(node.querySelectorAll("button")).find((x) =>
		x.textContent?.includes("store_checkout_submit"),
	);
it("shows one unchecked consent and no zero-balance/zero-discount controls", async () =>
	fixture(async (node) => {
		expect(node.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
		expect(node.textContent).not.toContain("promotion_use_balance");
		expect(node.textContent).not.toContain("wallet_payment");
		expect(node.textContent).not.toContain("promotion_discount");
		expect(pay(node)?.disabled).toBe(true);
	}));
it("never enables payment when eligibility fails, even after consent", async () => {
	f.eligibility = "error";
	await fixture(async (node) => {
		for (const input of node.querySelectorAll<HTMLElement>('[role="checkbox"]'))
			await act(async () => input.click());
		expect(pay(node)?.disabled).toBe(true);
		expect(f.checkout).not.toHaveBeenCalled();
	});
});
it("uses the existing balance path once when rewards and wallet cover access", async () => {
	f.balance = "600";
	f.reward = "400";
	await fixture(async (node) => {
		expect(node.querySelectorAll('[role="switch"]')).toHaveLength(1);
		expect(node.querySelectorAll('input[type="radio"]')).toHaveLength(0);
		await act(async () => consent(node)?.click());
		await act(async () => node.querySelector("form")?.requestSubmit());
		expect(f.checkout.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				data: expect.objectContaining({
					items: [
						expect.objectContaining({ sellableItemId: itemId, quantity: 1 }),
					],
					useBalance: true,
					walletPayment: false,
					paymentChannelId: null,
					agentAccessTermsAccepted: true,
					termsAccepted: true,
				}),
			}),
		);
	});
});
it("preserves external payment selection for partial balance, with one balance control", async () => {
	f.balance = "200";
	f.reward = "300";
	await fixture(async (node) => {
		expect(node.querySelectorAll('[role="switch"]')).toHaveLength(1);
		expect(node.textContent).not.toContain("wallet_payment");
		expect(node.querySelectorAll('input[type="radio"]')).toHaveLength(2);
		await act(async () => consent(node)?.click());
		await act(async () => node.querySelector("form")?.requestSubmit());
		expect(f.checkout.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				data: expect.objectContaining({
					useBalance: true,
					paymentChannelId: "crypto",
				}),
			}),
		);
	});
});

it.each([
	"binding_required",
	"already_active",
])("keeps %s access out of payment", async (state) => {
	f.eligibility = state;
	await fixture(async (node) => {
		await act(async () => consent(node)?.click());
		expect(pay(node)?.disabled).toBe(true);
		node.querySelector("form")?.requestSubmit();
		expect(f.checkout).not.toHaveBeenCalled();
	});
});
it("can opt out of balance and uses the original external-payment path", async () => {
	f.balance = "600";
	f.reward = "400";
	await fixture(async (node) => {
		await act(async () =>
			node.querySelector<HTMLElement>('[role="switch"]')?.click(),
		);
		expect(node.querySelectorAll('input[type="radio"]')).toHaveLength(2);
		await act(async () => consent(node)?.click());
		await act(async () => node.querySelector("form")?.requestSubmit());
		expect(f.checkout.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				data: expect.objectContaining({
					useBalance: false,
					walletPayment: false,
					paymentChannelId: "crypto",
				}),
			}),
		);
	});
});
