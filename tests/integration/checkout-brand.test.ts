import { Miniflare } from "miniflare";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	invalidateSiteBrandCache,
	loadSiteBrand,
	loadSiteBrandOrDefault,
} from "#/features/settings/server/site-brand";
import {
	createDatastoreCounters,
	instrumentD1,
	instrumentKv,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("checkout brand settings", () => {
	let miniflare: Miniflare;
	let database: D1Database;
	let cache: KVNamespace;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-checkout-brand" },
			kvNamespaces: ["CACHE"],
		});
		database = await miniflare.getD1Database("DB");
		cache = (await miniflare.getKVNamespace("CACHE")) as unknown as KVNamespace;
		await applyMigrations(database);
	});

	beforeEach(async () => {
		vi.spyOn(console, "info").mockImplementation(() => undefined);
		await database
			.prepare(
				"DELETE FROM system_settings WHERE key IN ('site.name', 'site.custom_html', 'site.logo_url', 'site.default_locale')",
			)
			.run();
		const entries = await cache.list({ prefix: "site-brand:" });
		await Promise.all(entries.keys.map(({ name }) => cache.delete(name)));
	});
	afterEach(() => vi.restoreAllMocks());

	it("uses D1 once for a cold brand load and KV for the warm load", async () => {
		const counters = createDatastoreCounters();
		const countedDatabase = instrumentD1(database, counters);
		const countedCache = instrumentKv(cache, counters);
		const cold = await loadSiteBrand(countedDatabase, countedCache);
		const warm = await loadSiteBrand(countedDatabase, countedCache);
		expect(warm).toEqual(cold);
		expect(counters.d1StatementAll).toBe(1);
		expect(counters.kvGet).toBe(2);
		expect(counters.kvPut).toBe(1);
		expect(
			vi.mocked(console.info).mock.calls.map(([metric]) => metric),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					cache: "site_brand",
					operation: "read",
					outcome: "miss",
					sampleRate: 1,
				}),
				expect.objectContaining({
					cache: "site_brand",
					operation: "write",
					outcome: "success",
					sampleRate: 1,
				}),
			]),
		);
	});

	it("coalesces concurrent cold loads and rebuilds malformed or version-mismatched cache values", async () => {
		await cache.put("site-brand:v1", "not-json");
		const counters = createDatastoreCounters();
		const countedDatabase = instrumentD1(database, counters);
		const countedCache = instrumentKv(cache, counters);
		const [first, second] = await Promise.all([
			loadSiteBrand(countedDatabase, countedCache),
			loadSiteBrand(countedDatabase, countedCache),
		]);
		expect(second).toEqual(first);
		expect(counters.d1StatementAll).toBe(1);
		expect(counters.kvGet).toBe(1);
		expect(counters.kvPut).toBe(1);
		expect(vi.mocked(console.info)).toHaveBeenCalledWith(
			expect.objectContaining({
				cache: "site_brand",
				operation: "read",
				outcome: "corrupt",
			}),
		);

		await cache.put(
			"site-brand:v1",
			JSON.stringify({ version: 2, brand: first }),
		);
		await expect(loadSiteBrand(countedDatabase, countedCache)).resolves.toEqual(
			first,
		);
		expect(counters.d1StatementAll).toBe(2);

		await cache.put(
			"site-brand:v1",
			JSON.stringify({
				version: 1,
				brand: {
					...first,
					title: "Forged title",
				},
			}),
		);
		await expect(loadSiteBrand(countedDatabase, countedCache)).resolves.toEqual(
			first,
		);
		expect(counters.d1StatementAll).toBe(3);
	});

	it("keeps secret settings out of the public brand snapshot", async () => {
		const secret = "brand-cache-secret-must-not-leak";
		await database
			.prepare(
				"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('runtime.data_encryption_secret', ?, 1, 0, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.bind(JSON.stringify(secret))
			.run();

		await loadSiteBrand(database, cache);
		const payload = await cache.get("site-brand:v1");
		expect(payload).toBeTruthy();
		expect(payload).not.toContain(secret);
		expect(payload).not.toMatch(/integration_config_secret|session|token/i);
	});

	it("does not trust corrupt brand KV when D1 fails, while the install shell uses safe defaults", async () => {
		await cache.put("site-brand:v1", "not-json");
		const unavailable = {
			prepare: () => ({
				all: async () => {
					throw new Error("D1 unavailable");
				},
			}),
		} as unknown as D1Database;

		await expect(loadSiteBrand(unavailable, cache)).rejects.toThrow(
			"D1 unavailable",
		);
		await expect(loadSiteBrandOrDefault(unavailable, cache)).resolves.toEqual({
			name: "老实人AI",
			logoUrl: "/favicon.png",
			title: "老实人AI 商城",
			customHtml: "",
			defaultLocale: "zh-CN",
		});
	});

	it("invalidates the cached brand after a setting changes", async () => {
		await loadSiteBrand(database, cache);
		const now = Date.now();
		await database
			.prepare(
				`INSERT INTO system_settings
				 (key, value, is_secret, created_at, updated_at)
				 VALUES ('site.name', '"Updated Edge"', 0, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			)
			.bind(now, now)
			.run();
		await invalidateSiteBrandCache(cache);
		expect(vi.mocked(console.info)).toHaveBeenCalledWith(
			expect.objectContaining({
				cache: "site_brand",
				operation: "delete",
				outcome: "success",
			}),
		);
		await expect(loadSiteBrand(database, cache)).resolves.toMatchObject({
			name: "Updated Edge",
			title: "Updated Edge",
		});
	});

	afterAll(async () => miniflare.dispose());

	it("returns safe defaults before customization", async () => {
		await expect(loadSiteBrand(database)).resolves.toEqual({
			name: "老实人AI",
			logoUrl: "/favicon.png",
			title: "老实人AI",
			customHtml: "",
			defaultLocale: "zh-CN",
		});
	});

	it("keeps the install shell available before system settings exist", async () => {
		const empty = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-edge-brand-before-install" },
		});
		try {
			const emptyDatabase = await empty.getD1Database("DB");
			await expect(loadSiteBrandOrDefault(emptyDatabase)).resolves.toEqual({
				name: "老实人AI",
				logoUrl: "/favicon.png",
				title: "老实人AI 商城",
				customHtml: "",
				defaultLocale: "zh-CN",
			});
		} finally {
			await empty.dispose();
		}
	});

	it("loads the checkout shell configuration from system settings", async () => {
		const now = Date.now();
		await database.batch(
			Object.entries({
				"site.name": "Edge Cashier",
				"site.custom_html":
					'<script src="https://chat.example/widget.js"></script>',
				"site.logo_url": "/api/site-logo?v=1",
				"site.default_locale": "zh-CN",
			}).map(([key, value]) =>
				database
					.prepare(
						"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
					)
					.bind(key, JSON.stringify(value), now, now),
			),
		);
		await expect(loadSiteBrand(database)).resolves.toMatchObject({
			name: "Edge Cashier",
			logoUrl: "/api/site-logo?v=1",
			title: "Edge Cashier",
			customHtml: '<script src="https://chat.example/widget.js"></script>',
			defaultLocale: "zh-CN",
		});
	});
});
