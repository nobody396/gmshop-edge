import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleAppStorePricesIngest,
	handleAppStorePricesPublic,
} from "#/features/appstore-prices/server/store";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { applyMigrations } from "./migrations";

const token = "appstore-token-for-tests";
const payload = {
	fetchedAt: 1_800_000_000_000,
	rates: {
		base: "CNY",
		date: "2026-11-10",
		rates: { USD: 0.15, JPY: 23.7, PHP: 9.43, TRY: 7.53 },
	},
	apple: [
		{
			app: "chatgpt",
			region: "ph",
			ok: true,
			items: [{ name: "ChatGPT Plus", price: "₱ 999.00" }],
		},
	],
	opentherank: [],
};

describe("App Store price endpoints", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const env = () =>
		({ DB: db, APPSTORE_PRICES_TOKEN: token }) as CloudflareBindings;
	const post = (bearer: string, body: unknown) =>
		new Request("https://shop.example/api/ops/appstore-prices", {
			method: "POST",
			headers: {
				authorization: `Bearer ${bearer}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
	});
	afterEach(async () => miniflare.dispose());

	it("stores an authorized ingest and serves it to any origin", async () => {
		const empty = await handleAppStorePricesPublic(env());
		expect(await empty.json()).toMatchObject({ ok: true, snapshot: null });

		const denied = await handleAppStorePricesIngest(
			post("wrong", payload),
			env(),
		);
		expect(denied.status).toBe(401);
		const bad = await handleAppStorePricesIngest(
			post(token, { nope: 1 }),
			env(),
		);
		expect(bad.status).toBe(400);

		const stored = await handleAppStorePricesIngest(
			post(token, payload),
			env(),
		);
		expect(stored.status).toBe(200);
		expect(await stored.json()).toMatchObject({
			ok: true,
			filled: 1,
			fresh: 1,
		});

		const response = await handleAppStorePricesPublic(env());
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("cache-control")).toContain("max-age=600");
		const body = (await response.json()) as {
			snapshot: {
				apps: {
					id: string;
					tiers: {
						id: string;
						cells: Record<string, { cny: number } | null>;
					}[];
				}[];
			};
		};
		expect(JSON.stringify(body)).not.toContain("laoshirenvip");
		const plus = body.snapshot.apps
			.find((app) => app.id === "chatgpt")
			?.tiers.find((tier) => tier.id === "plus");
		expect(plus?.cells.ph?.cny).toBe(106);
		expect(plus?.cells.us).toBeNull();
	});

	it("is unavailable without a configured token", async () => {
		const response = await handleAppStorePricesIngest(post(token, payload), {
			DB: db,
		} as CloudflareBindings);
		expect(response.status).toBe(503);
	});
});
