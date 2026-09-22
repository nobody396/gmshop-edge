import { afterEach, describe, expect, it, vi } from "vitest";
import {
	publicTurnstileConfig,
	turnstileAction,
	verifyTurnstile,
} from "../../../src/server/turnstile";

const config = {
	TURNSTILE_SITE_KEY: "public-test",
	TURNSTILE_SECRET_KEY: "private-test",
};
const request = (path = "/api/auth/sign-up/email", token = "test-token") =>
	new Request(`https://shop.example.com${path}`, {
		method: "POST",
		headers: { "cf-turnstile-response": token },
	});
afterEach(() => vi.unstubAllGlobals());
describe("Turnstile exact entry point enforcement", () => {
	it("only guards interactive password auth and new support conversations", () => {
		expect(turnstileAction(request())).toBe("register");
		expect(turnstileAction(request("/api/auth/sign-in/email/"))).toBe("login");
		expect(turnstileAction(request("/api/support/web/conversations"))).toBe(
			"support",
		);
		for (const path of [
			"/api/auth/callback/google",
			"/api/auth/telegram/callback",
			"/api/payments/callback",
			"/api/supply/orders",
			"/api/auth/sign-in/email-otp",
		])
			expect(turnstileAction(request(path))).toBeNull();
		expect(
			turnstileAction(
				new Request("https://shop.example.com/api/auth/sign-in/email"),
			),
		).toBeNull();
	});
	it("is explicitly optional with no configuration and never exposes the secret", async () => {
		expect(await verifyTurnstile(request(), {})).toBeNull();
		expect(publicTurnstileConfig(config)).toEqual({
			enabled: true,
			siteKey: "public-test",
		});
	});
	it("fails closed for incomplete configuration and missing/oversized tokens", async () => {
		for (const partial of [
			{ TURNSTILE_SITE_KEY: "public-test" },
			{ TURNSTILE_SECRET_KEY: "private-test" },
		])
			expect((await verifyTurnstile(request(), partial))?.status).toBe(503);
		for (const token of ["", "x".repeat(2049)])
			expect(
				(await verifyTurnstile(request(undefined, token), config))?.status,
			).toBe(403);
	});
	it("requires success, exact hostname and action, including rejection of replayed tokens", async () => {
		for (const result of [
			{ success: false, "error-codes": ["timeout-or-duplicate"] },
			{ success: true },
			{ success: true, hostname: "attacker.example.com", action: "register" },
			{ success: true, hostname: "shop.example.com", action: "login" },
		]) {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(result)));
			expect((await verifyTurnstile(request(), config))?.status).toBe(403);
		}
		const fetcher = vi.fn().mockResolvedValue(
			Response.json({
				success: true,
				hostname: "shop.example.com",
				action: "register",
			}),
		);
		vi.stubGlobal("fetch", fetcher);
		expect(await verifyTurnstile(request(), config)).toBeNull();
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
		);
		expect(fetcher.mock.calls[0]?.[1].body.get("secret")).toBe("private-test");
	});
	it("fails closed on upstream outage and network timeout", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("error", { status: 500 })),
		);
		expect((await verifyTurnstile(request(), config))?.status).toBe(503);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
		expect((await verifyTurnstile(request(), config))?.status).toBe(503);
	});
});
