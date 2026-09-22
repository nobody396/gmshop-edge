import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "#/db/schema";
import { createAuth } from "#/features/auth/server/auth-factory";
import type { RuntimeAuthProvider } from "#/features/auth/server/provider-runtime";
import type { TelegramWidgetAuthData } from "#/features/auth/telegram-widget";
import { installSystem } from "#/features/installation/server/install";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("Telegram Widget fallback login", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let auth: ReturnType<typeof createAuth>;
	const runtime = createInitialRuntimeConfig("https://shop.example");
	const botToken = "123456:telegram-widget-token-value";

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-telegram-widget-auth" },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		await installSystem(
			drizzle(database, { schema }),
			{
				name: "Root",
				email: "root@example.com",
				password: "root-secure-password",
			},
			runtime,
		);
		auth = createAuth(drizzle(database, { schema }), {
			BETTER_AUTH_SECRET: runtime.betterAuthSecret,
			BETTER_AUTH_URL: runtime.betterAuthUrl,
			AUTH_PROVIDERS: [telegramProvider(botToken)],
		});
	});

	beforeEach(async () => {
		// Independent payload tests must not consume each other's durable request budget.
		await database.prepare("DELETE FROM rate_limit_counters").run();
	});
	afterAll(async () => miniflare.dispose());

	it("verifies the signed fragment payload, creates a session, and rejects replay", async () => {
		const authData = await signedWidgetData(botToken, {
			id: 1_298_297_851,
			first_name: "Telegram Shopper",
			username: "shopper",
			photo_url: "https://cdn.example/telegram-widget-avatar.jpg",
			auth_date: Math.floor(Date.now() / 1_000),
		});
		const request = () =>
			auth.handler(
				new Request("https://shop.example/api/auth/telegram/signin", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "https://shop.example",
					},
					body: JSON.stringify(authData),
				}),
			);

		const response = await request();
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toContain(
			"better-auth.session_token",
		);
		expect(
			await database
				.prepare(`SELECT
				 (SELECT COUNT(*) FROM users WHERE email = '1298297851@telegram.invalid') AS users,
				 (SELECT COUNT(*) FROM accounts WHERE provider_id = 'telegram' AND account_id = '1298297851') AS accounts,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'auth.telegram_widget_signed_in') AS audits,
				 (SELECT COUNT(*) FROM verifications WHERE identifier LIKE 'telegram-widget:%') AS receipts`)
				.first(),
		).toEqual({ users: 1, accounts: 1, audits: 1, receipts: 1 });

		const replay = await request();
		expect(replay.status).toBe(401);
		expect(await replay.text()).not.toContain(botToken);
	});

	it("starts social login when Telegram will return a widget fragment", async () => {
		const response = await auth.handler(
			new Request("https://shop.example/api/auth/sign-in/social", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://shop.example",
				},
				body: JSON.stringify({
					provider: "telegram",
					callbackURL: "/account",
					disableRedirect: true,
				}),
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { url: string };
		const url = new URL(body.url);
		expect(url.origin).toBe("https://oauth.telegram.org");
		expect(url.searchParams.get("origin")).toBe("https://shop.example");
	});

	it("rejects an untrusted browser origin", async () => {
		const authData = await signedWidgetData(botToken, {
			id: 42,
			first_name: "Untrusted",
			auth_date: Math.floor(Date.now() / 1_000),
		});
		const response = await auth.handler(
			new Request("https://shop.example/api/auth/telegram/signin", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "https://evil.example",
				},
				body: JSON.stringify(authData),
			}),
		);
		expect(response.status).toBe(403);
	});

	it("rejects forged and expired fragment payloads", async () => {
		const current = await signedWidgetData(botToken, {
			id: 43,
			first_name: "Forged",
			auth_date: Math.floor(Date.now() / 1_000),
		});
		const expired = await signedWidgetData(botToken, {
			id: 44,
			first_name: "Expired",
			auth_date: Math.floor((Date.now() - 301_000) / 1_000),
		});
		for (const authData of [{ ...current, first_name: "Modified" }, expired]) {
			const response = await auth.handler(
				new Request("https://shop.example/api/auth/telegram/signin", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "https://shop.example",
					},
					body: JSON.stringify(authData),
				}),
			);
			expect(response.status).toBe(401);
		}
	});
});

function telegramProvider(botToken: string): RuntimeAuthProvider {
	return {
		id: "22222222-2222-4222-8222-222222222222",
		providerId: "telegram",
		providerType: "social",
		displayName: "Telegram",
		clientId: "123456789",
		clientSecret: null,
		scopes: ["openid", "profile"],
		allowSignup: true,
		revision: 1,
		telegramBotUserId: "123456",
		telegramBotUsername: "gmshop_test_bot",
		telegramBotToken: botToken,
		telegramMiniAppEnabled: false,
	};
}

async function signedWidgetData(
	botToken: string,
	data: Omit<TelegramWidgetAuthData, "hash">,
): Promise<TelegramWidgetAuthData> {
	const checkString = Object.entries(data)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
	const secret = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(botToken),
	);
	const key = await crypto.subtle.importKey(
		"raw",
		secret,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(checkString),
		),
	);
	return {
		...data,
		hash: Array.from(signature, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
	};
}
