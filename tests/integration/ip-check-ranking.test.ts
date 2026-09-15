import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { handleIpCheck } from "#/features/ip-check/server/lookup";
import { adaptCloudflareEnv } from "#/server/runtime/cloudflare";
import { applyMigrations } from "./migrations";

let mf: Miniflare;
let db: D1Database;
beforeAll(async () => {
	mf = new Miniflare({
		modules: true,
		script: "export default {fetch(){return new Response('ok')}}",
		d1Databases: { DB: "ip-check-ranking-test" },
	});
	db = await mf.getD1Database("DB");
	await applyMigrations(db);
});
afterAll(async () => {
	await mf.dispose();
});
afterEach(() => vi.restoreAllMocks());
function request() {
	const req = new Request("https://shop.example/api/ip-check", {
		headers: { "cf-connecting-ip": "203.0.113.10" },
	});
	Object.defineProperty(req, "cf", {
		value: { country: "US", asn: 12345, asOrganization: "Example" },
	});
	return req;
}
function mockProvider() {
	vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
		Response.json({
			ip: "203.0.113.10",
			isp: { asn: "AS12345", org: "Example" },
			location: {
				country_code: "US",
				city: "Example",
				timezone: "America/New_York",
			},
			risk: {
				is_datacenter: false,
				is_vpn: false,
				is_proxy: false,
				is_tor: false,
				is_mobile: false,
				risk_score: 0,
			},
		}),
	);
}
it("migrates an empty D1 and counts the same IP at most once per day", async () => {
	mockProvider();
	const env = adaptCloudflareEnv({ DB: db });
	const first = await handleIpCheck(request(), env);
	const second = await handleIpCheck(request(), env);
	expect(await first?.json()).toMatchObject({
		score: 100,
		ranking: { total: 1, percentile: 0 },
	});
	expect(await second?.json()).toMatchObject({
		score: 100,
		ranking: { total: 1 },
	});
	expect(
		await db
			.prepare("SELECT SUM(count) AS total FROM ip_check_score_buckets")
			.first(),
	).toEqual({ total: 1 });
	const counters = await db
		.prepare(
			"SELECT bucket_key FROM rate_limit_counters WHERE bucket_key LIKE 'ip-check:%'",
		)
		.all<{ bucket_key: string }>();
	expect(JSON.stringify(counters.results)).not.toContain("203.0.113.10");
});
it("excludes old and future bins and uses the day index", async () => {
	const day = Math.floor(Date.now() / 86400000);
	await db
		.prepare(
			"INSERT INTO ip_check_score_buckets(day,score,count) VALUES (?,0,100),(?,0,100)",
		)
		.bind(day - 31, day + 1)
		.run();
	mockProvider();
	expect(
		await (
			await handleIpCheck(request(), adaptCloudflareEnv({ DB: db }))
		)?.json(),
	).toMatchObject({ ranking: { total: 1 } });
	const plan = await db
		.prepare(
			"EXPLAIN QUERY PLAN SELECT SUM(count) FROM ip_check_score_buckets WHERE day >= ? AND day <= ?",
		)
		.bind(day - 29, day)
		.all<{ detail: string }>();
	expect(plan.results.some((row) => row.detail.includes("INDEX"))).toBe(true);
});
