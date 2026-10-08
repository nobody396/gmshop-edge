// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	user: { id: "buyer-a", email: "a@customer.test", emailVerified: true } as {
		id: string;
		email: string;
		emailVerified: boolean;
	} | null,
}));
vi.mock("#/features/auth/auth-client", () => ({
	authClient: {
		useSession: () => ({ data: state.user ? { user: state.user } : null }),
	},
}));
vi.mock("#/features/agent-access/server/functions", () => ({
	getAgentDeliveryFn: async () => ({
		kind: "api",
		state: "active",
		orderStatus: "completed",
		email: state.user?.email,
	}),
	openAgentAccountFn: async () => ({
		url: "https://lsrai.shop/auth/login",
		initialPassword: "SYNTHETIC-PASSWORD-ONLY",
	}),
	checkAgentAccessFn: vi.fn(),
}));
vi.mock("#/features/agent-access/server/admin", () => ({
	listAgentAccessIssuesFn: vi.fn(),
	prepareAgentProductsFn: vi.fn(),
	retryAgentAccessFn: vi.fn(),
}));
vi.mock("#/paraglide/messages", () => ({
	m: new Proxy({}, { get: (_, key) => () => String(key) }),
}));
vi.mock("#/paraglide/runtime", () => ({ getLocale: () => "en-US" }));

import { AgentAccessDelivery } from "#/features/agent-access/components/access";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("clears revealed initial credentials on account switch and logout", async () => {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const render = async () => {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<AgentAccessDelivery orderNumber="local-order" />
				</QueryClientProvider>,
			);
			await new Promise((r) => setTimeout(r, 20));
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
	};
	try {
		await render();
		const button = Array.from(node.querySelectorAll("button")).find(
			(b) => b.textContent === "agent_access_open",
		);
		expect(button).toBeDefined();
		await act(async () => {
			button?.click();
			await new Promise((r) => setTimeout(r, 20));
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(node.textContent).toContain("SYNTHETIC-PASSWORD-ONLY");
		state.user = {
			id: "buyer-b",
			email: "b@customer.test",
			emailVerified: true,
		};
		await render();
		expect(node.textContent).not.toContain("SYNTHETIC-PASSWORD-ONLY");
		state.user = null;
		await render();
		expect(node.textContent).toBe("agent_access_sign_in");
	} finally {
		await act(async () => root.unmount());
		client.clear();
		node.remove();
	}
});
