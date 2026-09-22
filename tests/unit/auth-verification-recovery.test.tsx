// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AuthAnimationProvider } from "#/features/auth/components/auth-animation-context";
import { UserAuthForm } from "#/features/auth/components/user-auth-form";

const mocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	signIn: vi.fn(async () => ({ error: { code: "EMAIL_NOT_VERIFIED" } })),
}));
vi.mock("@tanstack/react-router", () => ({
	Link: "a",
	useNavigate: () => mocks.navigate,
}));
vi.mock("#/features/auth/auth-client", () => ({
	authClient: { signIn: { email: mocks.signIn } },
}));
vi.mock("#/features/auth/server/provider-admin", () => ({
	listPublicAuthProvidersFn: async () => [
		{
			providerId: "credential",
			providerType: "email",
			passwordLoginEnabled: true,
			allowSignup: true,
			emailOtpEnabled: false,
		},
	],
}));
vi.mock("sonner", () => ({
	toast: {
		promise: (
			promise: Promise<unknown>,
			options: {
				success: (value: unknown) => unknown;
				error: (error: unknown) => unknown;
			},
		) => promise.then(options.success).catch(options.error),
	},
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("takes an existing unverified customer to resend without storing the password", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(
				<QueryClientProvider client={new QueryClient()}>
					<AuthAnimationProvider>
						<UserAuthForm />
					</AuthAnimationProvider>
				</QueryClientProvider>,
			);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await act(async () => {
			for (const [id, value] of [
				["sign-in-email", "existing@example.com"],
				["sign-in-password", "valid-test-password"],
			]) {
				const input = container.querySelector<HTMLInputElement>(`#${id}`);
				expect(input).not.toBeNull();
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set?.call(input, value);
				input?.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
		await act(async () => {
			container.querySelector("form")?.requestSubmit();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(mocks.signIn).toHaveBeenCalled();
		expect(mocks.navigate).toHaveBeenCalledWith({ to: "/verify-email-sent" });
		expect(sessionStorage.getItem("gmshop.pending_verification_email")).toBe(
			"existing@example.com",
		);
		expect(JSON.stringify(sessionStorage)).not.toContain("valid-test-password");
	} finally {
		await act(async () => root.unmount());
		container.remove();
		sessionStorage.clear();
	}
});
