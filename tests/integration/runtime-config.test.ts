import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	encryptFeishuAppSecret,
	feishuAlertSettingKeys,
	loadFeishuAlertSettings,
	resolveFeishuAlertCredentials,
	upsertFeishuAlertSetting,
} from "#/features/telegram/server/feishu-alerts";
import { loadRequestAllowedHosts } from "#/server/middleware/authority";
import {
	createInitialRuntimeConfig,
	loadRequestRuntimeConfig,
	loadRuntimeConfig,
	runtimeConfigEntries,
} from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("database-backed runtime configuration", () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-runtime-config" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
	});

	afterAll(async () => miniflare.dispose());

	it("loads database values and sees updates immediately", async () => {
		await db.batch([
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.better_auth_secret', ?, 1, 1, 1)",
				)
				.bind(JSON.stringify("database-auth-secret")),
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.better_auth_url', ?, 0, 1, 1)",
				)
				.bind(JSON.stringify("https://database.example")),
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1)",
				)
				.bind(JSON.stringify("database-data-secret")),
		]);
		await expect(loadRuntimeConfig(db)).resolves.toMatchObject({
			betterAuthSecret: "database-auth-secret",
			betterAuthUrl: "https://database.example",
			dataEncryptionSecret: "database-data-secret",
			authProviderSecret: "database-data-secret",
			commerceSecret: "database-data-secret",
			integrationConfigSecret: "database-data-secret",
		});
		await db
			.prepare(
				"UPDATE system_settings SET value = ?, updated_at = 2 WHERE key = 'runtime.data_encryption_secret'",
			)
			.bind(JSON.stringify("rotated-database-data-secret"))
			.run();
		const rotated = await loadRuntimeConfig(db);
		expect(rotated.dataEncryptionSecret).toBe("rotated-database-data-secret");
		expect(rotated.commerceSecret).toBe(rotated.dataEncryptionSecret);
		expect(rotated.integrationConfigSecret).toBe(rotated.dataEncryptionSecret);
	});

	it("generates install secrets and marks only the public URL as non-secret", () => {
		const initial = createInitialRuntimeConfig("https://pay.example");
		expect(initial.betterAuthSecret).toHaveLength(64);
		expect(JSON.parse(initial.dataEncryptionSecret)).toMatchObject({
			version: 1,
			current: "k1",
		});
		expect(initial.authProviderSecret).toBe(initial.dataEncryptionSecret);
		expect(initial.commerceSecret).toBe(initial.dataEncryptionSecret);
		expect(initial.integrationConfigSecret).toBe(initial.dataEncryptionSecret);
		const entries = runtimeConfigEntries(initial);
		expect(
			entries.find((entry) => entry.key === "runtime.better_auth_url"),
		).toMatchObject({ value: "https://pay.example", isSecret: false });
		expect(
			entries
				.filter((entry) => entry.key !== "runtime.better_auth_url")
				.every((entry) => entry.isSecret && entry.value.length >= 32),
		).toBe(true);
	});

	it("encrypts Feishu application credentials and exposes only configured state", async () => {
		const runtimeSecret = createInitialRuntimeConfig().dataEncryptionSecret;
		await db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.data_encryption_secret', ?, 1, 3, 3)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			)
			.bind(JSON.stringify(runtimeSecret))
			.run();
		const encrypted = await encryptFeishuAppSecret(db, "test-only-app-secret");
		await db.batch([
			upsertFeishuAlertSetting(db, feishuAlertSettingKeys.enabled, true, 3),
			upsertFeishuAlertSetting(
				db,
				feishuAlertSettingKeys.appId,
				"cli_1234567890abcdef",
				3,
			),
			upsertFeishuAlertSetting(
				db,
				feishuAlertSettingKeys.chatId,
				"oc_1234567890abcdef",
				3,
			),
			upsertFeishuAlertSetting(
				db,
				feishuAlertSettingKeys.appSecret,
				encrypted,
				3,
				true,
			),
		]);
		await expect(loadFeishuAlertSettings(db)).resolves.toMatchObject({
			enabled: true,
			appId: "cli_1234567890abcdef",
			chatId: "oc_1234567890abcdef",
			hasAppSecret: true,
		});
		await expect(resolveFeishuAlertCredentials(db)).resolves.toEqual({
			appId: "cli_1234567890abcdef",
			appSecret: "test-only-app-secret",
			chatId: "oc_1234567890abcdef",
		});
		const stored = await db
			.prepare("SELECT value, is_secret FROM system_settings WHERE key = ?")
			.bind(feishuAlertSettingKeys.appSecret)
			.first<{ value: string; is_secret: number }>();
		expect(stored?.is_secret).toBe(1);
		expect(stored?.value).not.toContain("test-only-app-secret");
	});

	it("deduplicates runtime settings only within one Request object", async () => {
		const all = vi.fn(async () => ({ results: [] }));
		const bind = vi.fn(() => ({ all }));
		const prepare = vi.fn(() => ({ bind }));
		const fakeDb = { prepare } as unknown as D1Database;
		const request = new Request("https://pay.example/admin");

		await Promise.all([
			loadRequestRuntimeConfig(request, fakeDb),
			loadRequestRuntimeConfig(request, fakeDb),
		]);
		expect(prepare).toHaveBeenCalledTimes(1);

		await loadRequestRuntimeConfig(
			new Request("https://pay.example/admin"),
			fakeDb,
		);
		expect(prepare).toHaveBeenCalledTimes(2);
	});

	it("shares one settings read between runtime config and authority", async () => {
		const all = vi.fn(async () => ({
			results: [
				{
					key: "security.allowed_hosts",
					value: JSON.stringify(["pay.example"]),
				},
			],
		}));
		const bind = vi.fn(() => ({ all }));
		const prepare = vi.fn(() => ({ bind }));
		const fakeDb = { prepare } as unknown as D1Database;
		const request = new Request("https://pay.example/admin");

		await Promise.all([
			loadRequestRuntimeConfig(request, fakeDb),
			loadRequestAllowedHosts(request, fakeDb),
		]);

		expect(prepare).toHaveBeenCalledTimes(1);
		expect(bind).toHaveBeenCalledWith(
			"runtime.better_auth_secret",
			"runtime.better_auth_url",
			"runtime.data_encryption_secret",
			"security.allowed_hosts",
		);
	});
});
