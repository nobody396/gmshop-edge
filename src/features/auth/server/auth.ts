import { resolveRequestAuthBaseUrl } from "#/features/auth/server/auth-base-url";
import { createAuth } from "#/features/auth/server/auth-factory";
import {
	authProviderRevisionSignature,
	loadRuntimeAuthProviders,
} from "#/features/auth/server/provider-runtime";
import { trustedOriginsFromAllowedHosts } from "#/features/auth/trusted-hosts";
import { getCloudflareEnv, getDb } from "#/server/db.server";
import { loadRequestAllowedHosts } from "#/server/middleware/authority";
import { loadRequestRuntimeConfig } from "#/server/runtime-config";

const authCache = new WeakMap<
	object,
	{ auth: ReturnType<typeof createAuth>; signature: string }
>();
export async function getAuth(request: Request) {
	const env = getCloudflareEnv(request);
	const d1 = env?.DB;
	if (!d1) throw new Error("D1 binding DB is unavailable");
	const [runtime, trustedOrigins, emailPolicy] = await Promise.all([
		loadRequestRuntimeConfig(request, d1, new URL(request.url).origin),
		loadTrustedOrigins(request, d1),
		loadEmailPolicy(d1),
	]);
	if (runtime.betterAuthSecret.length < 32)
		throw new Error("BETTER_AUTH_SECRET has not been initialized");
	const authProviders = await loadRuntimeAuthProviders(
		d1,
		runtime.authProviderSecret,
		runtime.integrationConfigSecret,
	);
	const authBaseUrl = resolveRequestAuthBaseUrl(
		request,
		runtime.betterAuthUrl,
		trustedOrigins,
	);
	const signature = `${runtime.betterAuthSecret}:${authBaseUrl}:${trustedOrigins.join(",")}:${authProviderRevisionSignature(authProviders)}:${JSON.stringify(emailPolicy)}`;
	const cached = authCache.get(d1);
	if (cached?.signature === signature) return cached.auth;
	const auth = createAuth(getDb(request), {
		BETTER_AUTH_SECRET: runtime.betterAuthSecret,
		BETTER_AUTH_URL: authBaseUrl,
		TRUSTED_ORIGINS: trustedOrigins,
		AUTH_PROVIDERS: authProviders,
		AUTH_PROVIDER_SECRET: runtime.authProviderSecret,
		EMAIL_DELIVERY_ENABLED: emailPolicy.enabled,
		REQUIRE_EMAIL_VERIFICATION: emailPolicy.requireVerification,
		SITE_NAME: emailPolicy.siteName,
		SESSION_MAX_AGE_SECONDS: emailPolicy.sessionMaxAgeSeconds,
	});
	authCache.set(d1, { auth, signature });
	return auth;
}

async function loadEmailPolicy(db: D1Database) {
	const [config, settings] = await Promise.all([
		db
			.prepare(
				"SELECT enabled FROM notification_channel_configs WHERE channel = 'email' LIMIT 1",
			)
			.first<{ enabled: number }>(),
		db
			.prepare(
				`SELECT key, value FROM system_settings
				 WHERE key IN ('auth.require_email_verification', 'auth.session_max_age_seconds', 'site.name')`,
			)
			.all<{ key: string; value: string }>(),
	]);
	const values = new Map(settings.results.map((row) => [row.key, row.value]));
	return {
		enabled: Boolean(config?.enabled),
		requireVerification:
			parseSetting(values.get("auth.require_email_verification")) === true,
		siteName:
			String(parseSetting(values.get("site.name")) ?? "GMShop Edge").slice(
				0,
				80,
			) || "GMShop Edge",
		sessionMaxAgeSeconds: validSessionMaxAge(
			parseSetting(values.get("auth.session_max_age_seconds")),
		),
	};
}

function validSessionMaxAge(value: unknown) {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 3_600 &&
		value <= 31_536_000
		? value
		: 2_592_000;
}

function parseSetting(value: string | undefined): unknown {
	if (!value) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

async function loadTrustedOrigins(request: Request, db: D1Database) {
	return trustedOriginsFromAllowedHosts(
		await loadRequestAllowedHosts(request, db),
	);
}
