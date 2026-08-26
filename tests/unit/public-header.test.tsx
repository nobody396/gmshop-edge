// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	root: false,
	session: {
		data: null as { user: { email: string; image: null; name: string } } | null,
		isPending: false,
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: { root: mocks.root } }),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
		<a href={to}>{children}</a>
	),
}));

vi.mock("#/features/auth/auth-client", () => ({
	authClient: { useSession: () => mocks.session },
}));

vi.mock("#/features/auth/server/session", () => ({
	getStorefrontAdminEntryFn: vi.fn(),
}));

vi.mock("#/features/storefront/cart-storage", () => ({
	useLocalCart: () => ({ items: [] }),
}));

vi.mock("#/features/exchange-rates/currency-context", () => ({
	useCurrency: () => ({
		currency: "USD",
		currencies: ["USD", "EUR"],
		setCurrency: vi.fn(),
	}),
}));

vi.mock("#/layouts/components/app-title", () => ({
	AppTitle: () => <span>GMShop Edge</span>,
}));

vi.mock("#/layouts/components/sign-out-dialog", () => ({
	SignOutDialog: () => null,
}));

vi.mock("#/layouts/public/account-settings-panel", () => ({
	AccountSettingsPanel: ({
		root,
		user,
	}: {
		root?: boolean;
		user?: { email?: string } | null;
	}) => (
		<div>
			panel:{user?.email || "guest"}:{root ? "root" : "customer"}
		</div>
	),
}));

vi.mock("#/paraglide/messages", () => ({
	m: new Proxy(
		{
			public_sign_in: () => "Sign in",
			store_account_title: () => "My account",
			store_cart_title: () => "Cart",
			store_header_settings: () => "Store settings",
			store_my_preferences_description: () => "Preferences",
			store_nav_orders: () => "Orders",
			store_nav_shop: () => "Shop",
		},
		{
			get: (target, property) =>
				target[property as keyof typeof target] ?? (() => String(property)),
		},
	),
}));

import { PublicHeader } from "#/layouts/public/header";

describe("public header settings", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mocks.session.data = null;
		mocks.root = false;
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		vi.clearAllMocks();
	});

	it("shows settings triggers for guests and keeps desktop sign in", () => {
		act(() => root.render(<PublicHeader />));

		expect(
			container.querySelectorAll('[aria-label="Store settings"]'),
		).toHaveLength(1);
		expect(container.querySelectorAll('a[href="/sign-in"]')).toHaveLength(1);
	});

	it("routes Telegram support through the storefront bot, not a private account", () => {
		act(() => root.render(<PublicHeader />));
		const support = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("store_support"),
		);
		act(() => support?.click());

		expect(
			document.querySelector('a[href="https://t.me/laoshirenai_support_bot"]'),
		).not.toBeNull();
		expect(
			document.querySelector('a[href="https://t.me/bettercalljerrys"]'),
		).toBeNull();
	});

	it("replaces settings with the avatar and hides internal identity email", () => {
		mocks.root = true;
		mocks.session.data = {
			user: {
				email: "telegram-123@identity.gmshop.invalid",
				image: null,
				name: "Buyer",
			},
		};

		act(() => root.render(<PublicHeader />));

		expect(
			container.querySelectorAll('[aria-label="My account"]'),
		).toHaveLength(1);
		expect(container.querySelector('[aria-label="Store settings"]')).toBeNull();
		expect(container.querySelector('a[href="/sign-in"]')).toBeNull();
		expect(container.textContent).not.toContain("identity.gmshop.invalid");

		const avatar = container.querySelector<HTMLButtonElement>(
			'[aria-label="My account"]',
		);
		expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
		act(() => avatar?.click());
		expect(
			document.querySelector('[data-slot="popover-content"]'),
		).not.toBeNull();
		expect(document.body.textContent).toContain("panel:guest:root");
	});
});
