// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useTurnstile } from "#/features/auth/components/turnstile";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
function Form() {
	const challenge = useTurnstile("register");
	return (
		<div>
			{challenge.widget}
			<button
				type="button"
				disabled={!challenge.ready}
				onClick={challenge.reset}
			>
				Submit
			</button>
			<span>{challenge.headers["cf-turnstile-response"]}</span>
		</div>
	);
}
it("gates submission, expires tokens and remounts a fresh widget after each attempt", async () => {
	const client = new QueryClient();
	client.setQueryData(["public", "turnstile"], {
		enabled: true,
		siteKey: "public-test",
	});
	const element = document.createElement("div");
	document.body.appendChild(element);
	const root = createRoot(element);
	let callbacks: Record<string, unknown> = {};
	const render = vi.fn((_element, options) => {
		callbacks = options;
		return "widget";
	});
	const remove = vi.fn();
	Object.assign(window, { turnstile: { render, remove } });
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<Form />
				</QueryClientProvider>,
			),
		);
		expect(element.querySelector("button")?.disabled).toBe(true);
		await act(async () => {
			document
				.querySelector<HTMLScriptElement>(
					'script[src*="challenges.cloudflare.com"]',
				)
				?.dispatchEvent(new Event("load"));
		});
		expect(callbacks.action).toBe("register");
		await act(async () =>
			(callbacks.callback as (token: string) => void)("token-one"),
		);
		expect(element.querySelector("button")?.disabled).toBe(false);
		await act(async () => (callbacks["expired-callback"] as () => void)());
		expect(element.querySelector("button")?.disabled).toBe(true);
		await act(async () =>
			(callbacks.callback as (token: string) => void)("token-two"),
		);
		await act(async () => element.querySelector("button")?.click());
		expect(element.querySelector("button")?.disabled).toBe(true);
		expect(element.querySelector("span")?.textContent).toBe("");
		expect(remove).toHaveBeenCalledWith("widget");
		expect(render).toHaveBeenCalledTimes(2);
		await act(async () => (callbacks["error-callback"] as () => void)());
		expect(element.querySelector('[role="alert"]')).not.toBeNull();
	} finally {
		await act(async () => root.unmount());
		element.remove();
		client.clear();
	}
});
it("keeps explicitly disabled configuration usable", async () => {
	const client = new QueryClient();
	client.setQueryData(["public", "turnstile"], { enabled: false, siteKey: "" });
	const element = document.createElement("div");
	const root = createRoot(element);
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<Form />
				</QueryClientProvider>,
			),
		);
		expect(element.querySelector("button")?.disabled).toBe(false);
	} finally {
		await act(async () => root.unmount());
		client.clear();
	}
});
