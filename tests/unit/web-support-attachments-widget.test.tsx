// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
	const queryClient = new QueryClient();
	queryClient.setQueryData(["public", "turnstile"], {
		enabled: false,
		siteKey: "",
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<WebSupportWidget />
			</QueryClientProvider>,
		),
	);
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

it("replaces WeChat fallback with file selection without transmitting anything", () => {
	expect(document.body.textContent).not.toContain(
		"web_support_wechat_fallback",
	);
	expect(document.body.textContent).toContain("web_support_attachment_hint");
	expect(document.querySelector('input[type="file"]')).not.toBeNull();
	expect(button("web_support_attach")).toBeTruthy();
	expect(
		fetchMock.mock.calls.every((call) => !call[1] || call[1].method !== "POST"),
	).toBe(true);
});
it("previews and removes the selected file without sending", async () => {
	const input = document.querySelector('input[type="file"]');
	if (!input) throw new Error("Missing file input");
	Object.defineProperty(input, "files", {
		value: [new File(["example"], "test.txt", { type: "text/plain" })],
		configurable: true,
	});
	await act(async () =>
		input.dispatchEvent(new Event("change", { bubbles: true })),
	);
	expect(document.body.textContent).toContain("test.txt");
	expect(button("web_support_send").disabled).toBe(false);
	await act(async () => button("web_support_attachment_remove").click());
	expect(document.body.textContent).not.toContain("test.txt");
	expect(button("web_support_send").disabled).toBe(true);
});
it("uploads once after send and renders the authenticated download link", async () => {
	const input = document.querySelector('input[type="file"]');
	if (!input) throw new Error("Missing file input");
	Object.defineProperty(input, "files", {
		value: [new File(["example"], "test.txt")],
		configurable: true,
	});
	await act(async () =>
		input.dispatchEvent(new Event("change", { bubbles: true })),
	);
	fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => ({
		ok: true,
		json: async () =>
			init?.method === "POST"
				? {
						attachment: {
							id: "c9eb1140-5f4b-4121-9487-01a65b9b549c",
							name: "test.txt",
							mime: "application/octet-stream",
							size: 7,
						},
					}
				: {
						enabled: true,
						hasConversation: true,
						status: "active",
						replies: [],
					},
	}));
	await act(async () => button("web_support_send").click());
	expect(
		fetchMock.mock.calls.filter((call) => call[1]?.method === "POST"),
	).toHaveLength(1);
	expect(
		document.querySelector(
			'a[href="/api/support/web/attachments/c9eb1140-5f4b-4121-9487-01a65b9b549c?download=1"]',
		),
	).not.toBeNull();
});
it("rejects unsupported extensions before sending", async () => {
	const input = document.querySelector('input[type="file"]');
	if (!input) throw new Error("Missing input");
	Object.defineProperty(input, "files", {
		value: [new File(["x"], "test.exe")],
		configurable: true,
	});
	await act(async () =>
		input.dispatchEvent(new Event("change", { bubbles: true })),
	);
	expect(document.body.textContent).toContain("web_support_attachment_failed");
	expect(button("web_support_send").disabled).toBe(true);
});
