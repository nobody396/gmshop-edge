// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("#/features/auth/auth-client", () => ({
	authClient: { useSession: () => ({ data: null, isPending: false }) },
}));
vi.mock("#/features/telegram/web-support-storage", () => ({
	loadWebSupportMessages: async () => [
		{
			id: "local-message",
			role: "agent",
			text: "Existing support reply",
			createdAt: 1,
		},
	],
	getWebSupportIdentity: vi.fn(),
	decryptWebSupportReply: vi.fn(),
	saveWebSupportMessage: vi.fn(),
	setWebSupportConversationId: vi.fn(),
}));
vi.mock("#/paraglide/messages", () => ({
	m: new Proxy({}, { get: (_target, key) => () => String(key) }),
}));
vi.mock("#/paraglide/runtime", () => ({ getLocale: () => "en-US" }));

import { WebSupportWidget } from "#/features/telegram/components/web-support-widget";

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	fetchMock = vi.fn(async () => ({
		ok: true,
		json: async () => ({
			enabled: true,
			hasConversation: true,
			status: "active",
			replies: [],
		}),
	}));
	vi.stubGlobal("fetch", fetchMock);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => root.render(<WebSupportWidget />));
	await act(async () => button("web_support_button").click());
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

function button(label: string) {
	const match = [...document.querySelectorAll("button")].find(
		(element) =>
			element.getAttribute("aria-label") === label ||
			element.textContent?.trim() === label,
	);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

it("removes the universal order-CDK handoff and opens the QR without navigating", async () => {
	expect(document.body.textContent).not.toContain("web_support_order_notice");
	expect(
		document.querySelector('a[href="/support/wechat-jerrys.png"]'),
	).toBeNull();
	const originalUrl = location.href;
	await act(async () => button("web_support_wechat_fallback").click());
	expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
	expect(
		document
			.querySelector('img[src="/support/wechat-jerrys.png"]')
			?.getAttribute("alt"),
	).toBe("store_support_wechat_qr_alt");
	expect(document.body.textContent).toContain(
		"store_support_wechat_description",
	);
	expect(location.href).toBe(originalUrl);
	expect(
		fetchMock.mock.calls.every((call) => !call[1] || call[1].method !== "POST"),
	).toBe(true);
});

it("closes the QR with Escape and keeps the conversation and draft", async () => {
	const draft = document.querySelector("textarea");
	const setValue = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	if (!draft || !setValue) throw new Error("Missing draft input");
	await act(async () => {
		setValue.call(draft, "Unsent draft");
		draft.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const trigger = button("web_support_wechat_fallback");
	trigger.focus();
	await act(async () => trigger.click());
	await act(async () =>
		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		),
	);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
	expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
	expect(document.querySelector('section[role="dialog"]')).not.toBeNull();
	expect(document.body.textContent).toContain("Existing support reply");
	expect(document.querySelector("textarea")?.value).toBe("Unsent draft");
	expect(document.activeElement).toBe(trigger);
});

it("supports the QR close button without closing the support panel", async () => {
	await act(async () => button("web_support_wechat_fallback").click());
	const close = document.querySelector<HTMLButtonElement>(
		'[data-slot="dialog-content"] [data-slot="dialog-close"]',
	);
	expect(close).not.toBeNull();
	if (!close) throw new Error("Missing QR close button");
	await act(async () => close.click());
	expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
	expect(document.querySelector('section[role="dialog"]')).not.toBeNull();
});
