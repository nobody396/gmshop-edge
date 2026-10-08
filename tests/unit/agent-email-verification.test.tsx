// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
	reset: vi.fn(),
	send: vi.fn(async () => ({ error: null as null | { code: string } })),
	verify: vi.fn(async () => ({ error: null })),
	ready: true,
}));
vi.mock("#/features/auth/auth-client", () => ({
	authClient: {
		useSession: () => ({ data: null }),
		emailOtp: { sendVerificationOtp: mock.send },
		signIn: { emailOtp: mock.verify },
	},
}));
vi.mock("#/features/auth/components/turnstile", () => ({
	useTurnstile: () => ({
		ready: mock.ready,
		reset: mock.reset,
		headers: { "cf-turnstile-response": "synthetic-only" },
		widget: <span data-testid="captcha">human check</span>,
	}),
}));
vi.mock("#/paraglide/messages", () => ({
	m: new Proxy({}, { get: (_, key) => () => String(key) }),
}));
vi.mock("#/paraglide/runtime", () => ({ getLocale: () => "en-US" }));

import { AgentEmailVerification } from "#/features/agent-access/components/email-verification";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
	mock.reset.mockClear();
	mock.verify.mockClear();
	mock.send.mockReset().mockResolvedValue({ error: null });
	mock.ready = true;
});
async function fixture(run: (node: HTMLDivElement) => Promise<void>) {
	const node = document.createElement("div");
	document.body.appendChild(node);
	const root = createRoot(node);
	const client = new QueryClient();
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<AgentEmailVerification itemId="09900000-0000-4000-8000-000000000002" />
				</QueryClientProvider>,
			),
		);
		await run(node);
	} finally {
		await act(async () => root.unmount());
		client.clear();
		node.remove();
	}
}
async function input(node: HTMLElement, selector: string, value: string) {
	await act(async () => {
		const el = node.querySelector<HTMLInputElement>(selector);
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(el, value);
		el?.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function click(node: HTMLElement, text: string) {
	await act(async () => {
		Array.from(node.querySelectorAll("button"))
			.find((b) => b.textContent === text)
			?.click();
		await new Promise((r) => setTimeout(r, 10));
	});
	await act(async () => {
		await new Promise((r) => setTimeout(r, 10));
	});
}
it("successful send proceeds directly to OTP without a second CAPTCHA; explicit resend requests a fresh check", async () =>
	fixture(async (node) => {
		await input(node, "input[type=email]", "buyer@customer.com");
		await click(node, "auth_email_otp_send_code");
		expect(mock.send).toHaveBeenCalledTimes(1);
		expect(mock.reset).not.toHaveBeenCalled();
		expect(node.querySelector("[data-testid=captcha]")).toBeNull();
		mock.ready = false;
		await input(node, 'input[autocomplete="one-time-code"]', "654321");
		await click(node, "agent_access_verify_continue");
		expect(mock.verify).toHaveBeenCalledTimes(1);
		expect(mock.reset).not.toHaveBeenCalled();
		await click(node, "auth_reset_resend_code");
		expect(mock.reset).toHaveBeenCalledTimes(1);
		expect(node.querySelector("[data-testid=captcha]")).not.toBeNull();
	}));
it.each([
	["EMAIL_ADDRESS_UNDELIVERABLE", "auth_error_undeliverable_email"],
	["HUMAN_VERIFICATION_REQUIRED", "agent_access_reverify"],
	["TOO_MANY_REQUESTS", "auth_error_rate_limited"],
	["EMAIL_OTP_FLOW_DISABLED", "agent_access_original_login"],
])("preserves %s instead of incorrectly claiming a generic rate limit", async (code, message) => {
	mock.send.mockResolvedValue({ error: { code } });
	await fixture(async (node) => {
		await input(node, "input[type=email]", "buyer@customer.com");
		await click(node, "auth_email_otp_send_code");
		expect(node.querySelector("[role=alert]")?.textContent).toBe(message);
		expect(mock.reset).toHaveBeenCalledTimes(1);
	});
});
