// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

const presentation = vi.hoisted(() => ({ locale: "en-US" }));
vi.mock("#/paraglide/runtime", async (original) => ({
	...(await original<object>()),
	getLocale: () => presentation.locale,
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: undefined }),
	useMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
	...(await original<object>()),
	Link: ({ children, to }: { children: ReactNode; to: string }) => (
		<a href={to}>{children}</a>
	),
}));
vi.mock("#/features/promotions/account", () => ({
	PromotionAccount: () => null,
}));
vi.mock("#/components/pro/form", () => ({
	ModalForm: ({ trigger }: { trigger: ReactNode }) => trigger,
	ProSchemaForm: () => null,
}));
vi.mock("#/layouts/components/change-password-dialog", () => ({
	ChangePasswordForm: () => null,
}));
vi.mock("#/features/storefront/pages/account", () => ({
	AccountLoginMethods: () => null,
	AccountNotificationPreferences: () => null,
	AccountSessions: () => null,
}));

import { AccountOverviewPage } from "#/features/storefront/pages/account-sections";

const instant = Date.parse("2026-10-09T03:30:28Z");
const account = {
	user: {
		name: "Fixture",
		email: "fixture@example.test",
		emailVerified: true,
		preferredLocale: "en-US",
	},
	customerLinked: true,
	hasPassword: true,
	notificationPreferences: [],
	coupons: [],
	entitlements: [],
	orders: [
		{
			orderNumber: "GM-HYDRATION-FIXTURE",
			status: "completed",
			currency: "CNY",
			currencyDecimals: 2,
			totalMinor: "100",
			productName: "Fixture",
			itemCount: 1,
			createdAt: instant,
			updatedAt: instant,
		},
	],
} satisfies Parameters<typeof AccountOverviewPage>[0]["account"];
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it.each(
	["en-US", "zh-CN"].flatMap((locale) =>
		["America/New_York", "Asia/Shanghai"].map((timeZone) => ({
			locale,
			timeZone,
		})),
	),
)("hydrates real account order dates in $locale / $timeZone without text mismatch", async ({
	locale,
	timeZone,
}) => {
	presentation.locale = locale;
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const NativeDateTimeFormat = Intl.DateTimeFormat;
	let implicitTimeZone = "UTC";
	vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
		function DateTimeFormatMock(locales, options) {
			return new NativeDateTimeFormat(locales, {
				...options,
				timeZone: options?.timeZone ?? implicitTimeZone,
			});
		},
	);
	const format = (timeZone: string) =>
		new NativeDateTimeFormat(locale, {
			dateStyle: "medium",
			timeStyle: "medium",
			timeZone,
		}).format(instant);
	const element = document.createElement("div");
	container = element;
	container.innerHTML = renderToString(
		<AccountOverviewPage account={account} />,
	);
	document.body.appendChild(container);
	expect(container.textContent).toContain(format("UTC"));
	implicitTimeZone = timeZone;
	const onRecoverableError = vi.fn();
	await act(async () => {
		root = hydrateRoot(element, <AccountOverviewPage account={account} />, {
			onRecoverableError,
		});
	});
	expect(container.textContent).toContain(format(timeZone));
	expect(onRecoverableError.mock.calls.map(([error]) => String(error))).toEqual(
		[],
	);
});
