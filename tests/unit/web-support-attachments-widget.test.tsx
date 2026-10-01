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
			role: "support",
			text: "Existing support reply\nhttps://laoshirenvip.com/#self-service-recharge\nhttps://evil.example/guide\n<script>never run</script>",
			createdAt: 1,
		},
	],
	getWebSupportIdentity: vi.fn(),
	decryptWebSupportReply: vi.fn(),
	saveWebSupportMessage: vi.fn(async () => {}),
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

it("the buying guide is keyboard-accessible and opens without losing the support dialog", () => {
	const guide = document.querySelector<HTMLAnchorElement>(
		'a[href="https://laoshirenvip.com/#self-service-recharge"]',
	);
	expect(guide).not.toBeNull();
	expect(guide?.target).toBe("_blank");
	expect(guide?.rel).toContain("noopener");
	guide?.focus();
	expect(document.activeElement).toBe(guide);
	expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	expect(
		document.querySelector('a[href="https://evil.example/guide"]'),
	).toBeNull();
	expect(document.querySelector("script")).toBeNull();
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

it("pastes a screenshot into the composer without auto-sending", async () => {
	const composer = document.querySelector("textarea");
	if (!composer) throw new Error("Missing composer");
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: {
			files: [
				new File(
					[new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
					"pasted-screenshot.png",
					{ type: "image/png" },
				),
			],
		},
	});
	await act(async () => composer.dispatchEvent(event));
	expect(event.defaultPrevented).toBe(true);
	expect(document.body.textContent).toContain("pasted-screenshot.png");
	expect(button("web_support_send").disabled).toBe(false);
	expect(
		fetchMock.mock.calls.filter((call) => call[1]?.method === "POST"),
	).toHaveLength(0);
});

it("does not let an undecryptable legacy reply block the next reply", async () => {
	const { decryptWebSupportReply } = await import(
		"#/features/telegram/web-support-storage"
	);
	vi.mocked(decryptWebSupportReply).mockRejectedValueOnce(
		new DOMException("stale key", "OperationError"),
	);
	fetchMock.mockImplementation(async () => ({
		ok: true,
		json: async () => ({
			conversationId: "session-v2",
			status: "active",
			replies: [
				{
					id: "old-reply",
					sequence: 1,
					algorithm: "RSA-OAEP-256+A256GCM",
					created_at: Date.now(),
				},
				{
					id: "new-reply",
					sequence: 2,
					text: "new reply is visible",
					created_at: Date.now(),
				},
			],
		}),
	}));
	await act(async () => window.dispatchEvent(new Event("focus")));
	expect(document.body.textContent).toContain("new reply is visible");
	expect(document.body.textContent).toContain("web_support_legacy_unreadable");
	expect(
		fetchMock.mock.calls.filter((call) =>
			String(call[0]).includes("replies/ack"),
		),
	).toHaveLength(0);
	await act(async () => window.dispatchEvent(new Event("focus")));
	expect(
		document.body.textContent?.match(/new reply is visible/g),
	).toHaveLength(1);
});

it("shows sending feedback immediately and permits drafting without clearing the new draft", async () => {
	let finish: () => void = () => {};
	fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
		init?.method === "POST"
			? new Promise((resolve) => {
					finish = () =>
						resolve({ ok: true, json: async () => ({ sent: true }) });
				})
			: Promise.resolve({
					ok: true,
					json: async () => ({
						conversationId: "session-v2",
						status: "active",
						replies: [],
					}),
				}),
	);
	const composer = document.querySelector("textarea");
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	if (!composer || !setter) throw new Error("Missing composer");
	await act(async () => {
		setter.call(composer, "first message");
		composer.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => button("web_support_send").click());
	expect(document.body.textContent).toContain("web_support_sending_status");
	expect(composer.disabled).toBe(false);
	await act(async () => {
		setter.call(composer, "next draft");
		composer.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => finish());
	expect(composer.value).toBe("next draft");
	expect(button("web_support_send").disabled).toBe(false);
	expect(document.body.textContent).not.toContain("web_support_sending_status");
});

it("does not keep Send disabled while browser history persistence is slow", async () => {
	const { saveWebSupportMessage } = await import(
		"#/features/telegram/web-support-storage"
	);
	vi.mocked(saveWebSupportMessage).mockImplementationOnce(
		() => new Promise<void>(() => {}),
	);
	const composer = document.querySelector("textarea");
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	if (!composer || !setter) throw new Error("Missing composer");
	await act(async () => {
		setter.call(composer, "cache should not block");
		composer.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await act(async () => button("web_support_send").click());
	expect(document.body.textContent).toContain("cache should not block");
	expect(document.body.textContent).not.toContain("web_support_sending_status");
	await act(async () => {
		setter.call(composer, "next message");
		composer.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(button("web_support_send").disabled).toBe(false);
});
