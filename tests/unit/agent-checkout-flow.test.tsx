// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type PropsWithChildren } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	balance: "0",
	channelsUnavailable: false,
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
	quoteCheckoutPaymentChannelsFn: async () => {
		if (f.channelsUnavailable) throw new Error("external_channels_unavailable");
		return [
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
		];
	},
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
	f.channelsUnavailable = false;
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
it("shows one consent and a visible disabled wallet card even with zero balance", async () =>
	fixture(async (node) => {
		expect(node.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
		expect(node.textContent).not.toContain("promotion_use_balance");
		expect(node.textContent).toContain("wallet_payment");
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
		expect(node.querySelectorAll('[role="switch"]')).toHaveLength(0);
		expect(node.querySelectorAll('input[type="radio"]')).toHaveLength(3);
		expect(
			node.querySelector<HTMLInputElement>('input[value="wallet"]')?.checked,
		).toBe(true);
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
it("shows insufficient balance and charges full amount externally without silently using balance", async () => {
	f.balance = "200";
	f.reward = "300";
	await fixture(async (node) => {
		expect(node.querySelectorAll('[role="switch"]')).toHaveLength(0);
		expect(
			node.querySelector<HTMLInputElement>('input[value="wallet"]')?.disabled,
		).toBe(true);
		expect(node.textContent).toContain("wallet_payment_insufficient");
		expect(node.querySelectorAll('input[type="radio"]')).toHaveLength(3);
		await act(async () => consent(node)?.click());
		await act(async () => node.querySelector("form")?.requestSubmit());
		expect(f.checkout.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				data: expect.objectContaining({
					useBalance: false,
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
it("can choose Alipay explicitly even when wallet covers the order", async () => {
	f.balance = "600";
	f.reward = "400";
	await fixture(async (node) => {
		await act(async () =>
			node.querySelector<HTMLElement>('input[value="alipay"]')?.click(),
		);
		expect(node.querySelectorAll('input[type="radio"]')).toHaveLength(3);
		await act(async () => consent(node)?.click());
		await act(async () => node.querySelector("form")?.requestSubmit());
		expect(f.checkout.mock.calls[0]?.[0]).toEqual(
			expect.objectContaining({
				data: expect.objectContaining({
					useBalance: false,
					walletPayment: false,
					paymentChannelId: "alipay",
				}),
			}),
		);
	});
});

it("blocks submission if balance drops after choosing wallet", async () => {
	f.balance = "1000";
	await fixture(async (node, client) => {
		await act(async () => consent(node)?.click());
		expect(pay(node)?.disabled).toBe(false);
		f.balance = "0";
		await act(async () => {
			await client.refetchQueries({ queryKey: ["wallet"] });
			await new Promise((resolve) => setTimeout(resolve, 15));
		});
		expect(
			node.querySelector<HTMLInputElement>('input[value="wallet"]')?.checked,
		).toBe(true);
		expect(pay(node)?.disabled).toBe(true);
		await act(async () => node.querySelector("form")?.requestSubmit());
		expect(f.checkout).not.toHaveBeenCalled();
	});
});

it("wallet payment remains available when external payment channels fail", async () => {
	f.balance = "1000";
	f.channelsUnavailable = true;
	await fixture(async (node) => {
		expect(
			node.querySelector<HTMLInputElement>('input[value="wallet"]')?.disabled,
		).toBe(false);
		await act(async () => consent(node)?.click());
		expect(pay(node)?.disabled).toBe(false);
		await act(async () => node.querySelector("form")?.requestSubmit());
		expect(f.checkout.mock.calls[0]?.[0]).toMatchObject({
			data: { useBalance: true, paymentChannelId: null, walletPayment: false },
		});
	});
});
