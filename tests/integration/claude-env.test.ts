import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	claudeEnvProductId,
	dayMs,
	decodeActivationCode,
	signRelayRequest,
} from "#/features/claude-env/domain";
import {
	applySubscriptionAction,
	saveRelay,
} from "#/features/claude-env/server/admin-actions";
import type { IproyalClient } from "#/features/claude-env/server/iproyal";
import { IproyalError } from "#/features/claude-env/server/iproyal";
import {
	loadClaudeEnvPanel,
	revealClaudeEnvCode,
} from "#/features/claude-env/server/panel";
import { handleRelayApiRequest } from "#/features/claude-env/server/relay-api";
import { runClaudeEnv } from "#/features/claude-env/server/scheduler";
import { loadCrypt } from "#/features/claude-env/server/shared";
import { applyMigrations } from "./migrations";

const relaySecret =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const monthlySku = "c3bab030-0c3c-4451-9c41-3cc32538e778";
const quarterlySku = "1e599d3a-3aa2-498e-a955-f4b04a4abdc4";
const t0 = Date.parse("2026-10-24T00:00:00Z");
const minute = 60_000;

function fakeIproyal(overrides: Partial<IproyalClient> = {}) {
	const calls = { create: 0, extend: [] as Array<[string, number]> };
	let delivered = false;
	const client: IproyalClient = {
		balance: async () => 100,
		products: async () => ({
			data: [
				{
					id: 9,
					locations: [
						{
							id: 16,
							child_locations: [
								{ id: 100, name: "Seattle" },
								{ id: 187, name: "Springfield (Massachusetts)" },
							],
						},
					],
				},
			],
		}),
		price: async () => 5.2,
		createOrder: async () => {
			calls.create += 1;
			return "4242";
		},
		getOrder: async () => {
			if (!delivered) {
				delivered = true;
				return null;
			}
			return {
				ip: "161.77.8.204",
				port: 12323,
				username: "up-user",
				password: "up-pass",
				location: "United States",
			};
		},
		extendOrder: async (id, plan) => {
			calls.extend.push([id, plan]);
		},
		...overrides,
	};
	return { client, calls };
}

function qualityFetcher(trust: number, scam: number) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.startsWith("https://ip.net.coffee/"))
			return Response.json({ trust_score: trust });
		if (url.startsWith("https://scamalytics.com/"))
			return new Response(`<div>Fraud Score: ${scam}</div>`);
		if (url.startsWith("http://ip-api.com/"))
			return Response.json({ status: "success", timezone: "America/New_York" });
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch;
}

describe("Claude 专属环境 control center", { timeout: 60_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let messages: string[];
	const deliver = async (text: string) => {
		messages.push(text);
	};

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		messages = [];
		await db.batch([
			db.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.data_encryption_secret', '"claude-env-test-secret-0123456789"', 1, 1, 1)`,
			),
			db.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled) VALUES ('u1','Buyer','buyer1@example.com',1,1),('u2','Other','other@example.com',1,1),('agent','Agent','agent@example.com',1,1)",
			),
		]);
		await saveRelay(
			db,
			await loadCrypt(db),
			{ userId: "u1" },
			{
				id: "r1",
				hostname: "relay.example.com",
				secret: relaySecret,
				status: "active",
				maxCustomers: 10,
				monthlyQuotaBytes: 1000,
			},
			t0 - dayMs,
		);
	});

	afterEach(async () => miniflare.dispose());

	async function enable() {
		await db
			.prepare(
				`INSERT OR IGNORE INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('claude_env.automation_enabled', 'true', 0, 1, 1)`,
			)
			.run();
	}

	async function insertOrder(input: {
		id: string;
		userId: string | null;
		sku: string;
		paidAt: number;
		quantity?: number;
		status?: string;
		email?: string;
	}) {
		await db.batch([
			db
				.prepare(
					`INSERT INTO shop_orders (id, order_number, user_id, contact_email, normalized_contact_email, locale,
					 status, currency, currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor, version,
					 expires_at, paid_at, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, 'zh-CN', ?, 'CNY', 2, '29900', '0', '29900', '29900', 2, 1, ?, ?, ?)`,
				)
				.bind(
					input.id,
					`GM${input.id.toUpperCase()}`,
					input.userId,
					input.email ?? "buyer1@example.com",
					input.email ?? "buyer1@example.com",
					input.status ?? "completed",
					input.paidAt,
					input.paidAt,
					input.paidAt,
				),
			db
				.prepare(
					`INSERT INTO shop_order_items (id, order_id, product_id, sellable_item_id, delivery_component_id,
					 product_name, delivery_component_type, delivery_component_version, sellable_item_name, quantity,
					 unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'component', 'Claude 稳定使用环境', 'stock', 1, 'plan', ?, '29900', '0', '29900', 1, 1)`,
				)
				.bind(
					`${input.id}-item`,
					input.id,
					claudeEnvProductId,
					input.sku,
					input.quantity ?? 1,
				),
		]);
	}

	async function relayCall(
		method: "GET" | "POST",
		path: string,
		body: unknown,
		now: number,
		options: { secret?: string; relayId?: string; skewSeconds?: number } = {},
	) {
		const text = body === undefined ? "" : JSON.stringify(body);
		const timestamp = String(
			Math.floor(now / 1000) + (options.skewSeconds ?? 0),
		);
		const signature = await signRelayRequest({
			secret: options.secret ?? relaySecret,
			method,
			path,
			timestamp,
			body: text,
		});
		const response = await handleRelayApiRequest(
			new Request(`https://laoshirenvip.com${path}`, {
				method,
				headers: {
					"X-CE-Relay-Id": options.relayId ?? "r1",
					"X-CE-Timestamp": timestamp,
					"X-CE-Signature": signature,
					...(method === "POST" ? { "Content-Type": "application/json" } : {}),
				},
				body: method === "POST" ? text : undefined,
			}),
			{ db, now, deliver },
		);
		return { status: response.status, json: (await response.json()) as any };
	}

	const run = (
		now: number,
		iproyal: IproyalClient | undefined,
		fetcher = qualityFetcher(98, 32),
		sendCustomerEmail = vi.fn(async () => undefined),
	) => runClaudeEnv({ db, now, iproyal, fetcher, deliver, sendCustomerEmail });

	async function sub(where = "1=1") {
		return db
			.prepare(
				`SELECT * FROM claude_env_subscriptions WHERE ${where} ORDER BY created_at LIMIT 1`,
			)
			.first<Record<string, any>>();
	}

	/** Ingest → buy → poll → relay self-test ok. Returns the subscription id. */
	async function provision(iproyal: IproyalClient, fetcher?: typeof fetch) {
		await enable();
		await run(t0, iproyal);
		await insertOrder({
			id: "o1",
			userId: "u1",
			sku: monthlySku,
			paidAt: t0 + 1000,
		});
		await run(t0 + 2000, iproyal, fetcher);
		await run(t0 + 2 * minute, iproyal, fetcher);
		await run(t0 + 4 * minute, iproyal, fetcher);
		const row = await sub();
		expect(row?.status).toBe("provisioning");
		const report = await relayCall(
			"POST",
			"/api/claude-env/relay/v1/report",
			{
				report_id: "rep-1",
				relay_id: "r1",
				results: [
					{
						id: row?.id,
						applied: true,
						error: null,
						exit_ip: "161.77.8.204",
						exit_ok: true,
						anthropic_status: 401,
					},
				],
				traffic: [],
				host: null,
			},
			t0 + 5 * minute,
		);
		expect(report).toEqual({ status: 200, json: { ok: true } });
		return row?.id as string;
	}

	it("does nothing while the flag is off", async () => {
		await insertOrder({ id: "o1", userId: "u1", sku: monthlySku, paidAt: t0 });
		const { client, calls } = fakeIproyal();
		expect(await run(t0 + minute, client)).toEqual({ status: "disabled" });
		expect(calls.create).toBe(0);
		expect(await sub()).toBeNull();
	});

	it("provisions, quality-checks at the 80/40 boundary, activates and serves the panel only to the owner", async () => {
		const { client, calls } = fakeIproyal();
		await enable();
		await run(t0, client);
		// Paid before the flag was first seen on: never ingested.
		await insertOrder({
			id: "old",
			userId: "u2",
			sku: monthlySku,
			paidAt: t0 - 1000,
		});
		const id = await provision(client, qualityFetcher(80, 40));
		expect(calls.create).toBe(1);
		const row = await sub();
		expect(row).toMatchObject({
			relay_id: "r1",
			relay_port: 20000,
			ip: "161.77.8.204",
			ip_tz: "America/New_York",
			ip_city: "Springfield (Massachusetts)",
			iproyal_order_id: "4242",
			relay_check_ok: 1,
		});
		expect(row?.relay_user).toMatch(/^u[0-9a-f]{12}$/);
		expect(row?.ip_pass_encrypted).not.toContain("up-pass");
		expect(messages.some((m) => m.includes("新订单"))).toBe(true);

		const desired = await relayCall(
			"GET",
			"/api/claude-env/relay/v1/desired",
			undefined,
			t0 + 5 * minute,
		);
		expect(desired.status).toBe(200);
		expect(desired.json.relay_id).toBe("r1");
		expect(desired.json.customers).toEqual([
			{
				id,
				port: 20000,
				user: row?.relay_user,
				pass: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/),
				upstream: {
					ip: "161.77.8.204",
					port: 12323,
					user: "up-user",
					pass: "up-pass",
				},
				status: "provisioning",
			},
		]);

		const email = vi.fn(async () => undefined);
		await run(t0 + 6 * minute, client, qualityFetcher(80, 40), email);
		const active = await sub();
		expect(active?.status).toBe("active");
		expect(active?.expires_at).toBe(t0 + 6 * minute + 30 * dayMs);
		expect(email).toHaveBeenCalledWith(id);
		expect(messages.some((m) => m.includes("已开通"))).toBe(true);

		expect(await loadClaudeEnvPanel(db, "u2", "GMO1", t0)).toBeNull();
		expect(
			await revealClaudeEnvCode(db, await loadCrypt(db), "u2", "GMO1"),
		).toBeNull();
		const panel = await loadClaudeEnvPanel(db, "u1", "GMO1", t0 + 7 * minute);
		expect(panel).toMatchObject({
			state: "subscription",
			status: "active",
			ip: "161.77.8.204",
			city: "Springfield, Massachusetts",
			timezone: "America/New_York",
			daysLeft: 30,
			codeAvailable: true,
		});
		expect(JSON.stringify(panel)).not.toMatch(/4242|iproyal|up-pass/i);
		const revealed = await revealClaudeEnvCode(
			db,
			await loadCrypt(db),
			"u1",
			"GMO1",
		);
		const decoded = decodeActivationCode(revealed?.code ?? "");
		expect(decoded).toEqual({
			v: 1,
			host: "relay.example.com",
			port: 20000,
			user: row?.relay_user,
			pass: desired.json.customers[0].pass,
			ip: "161.77.8.204",
			tz: "America/New_York",
		});
		expect(revealed?.mac).toContain(
			`bash /tmp/claude-env.sh '${revealed?.code}'`,
		);
	});

	it("marks needs_replace when trust is 79 and never auto-replaces", async () => {
		const { client, calls } = fakeIproyal();
		await provision(client);
		await run(t0 + 6 * minute, client, qualityFetcher(79, 10));
		const row = await sub();
		expect(row?.status).toBe("needs_replace");
		expect(calls.create).toBe(1);
		expect(
			messages.some((m) => m.includes("24 小时内找 IPRoyal 客服换 IP")),
		).toBe(true);
		const desired = await relayCall(
			"GET",
			"/api/claude-env/relay/v1/desired",
			undefined,
			t0 + 7 * minute,
		);
		expect(desired.json.customers).toEqual([]);
		// Owner swaps the IP by hand → back to provisioning for a fresh check.
		await applySubscriptionAction(
			{ db, crypt: await loadCrypt(db), fetcher: qualityFetcher(98, 10) },
			{ userId: "u1" },
			{
				action: "replace_ip",
				id: row?.id,
				ip: "161.77.8.205",
				port: 12323,
				user: "n1",
				pass: "n2",
			},
			t0 + 8 * minute,
		);
		expect(await sub()).toMatchObject({
			status: "provisioning",
			ip: "161.77.8.205",
			relay_check_ok: 0,
		});
	});

	it("marks needs_replace when scamalytics is 41", async () => {
		const { client } = fakeIproyal();
		await provision(client);
		await run(t0 + 6 * minute, client, qualityFetcher(98, 41));
		expect((await sub())?.status).toBe("needs_replace");
	});

	it("needs_replace after 3 failed provisioning self-tests", async () => {
		const { client } = fakeIproyal();
		await enable();
		await run(t0, client);
		await insertOrder({
			id: "o1",
			userId: "u1",
			sku: monthlySku,
			paidAt: t0 + 1,
		});
		await run(t0 + 2000, client);
		await run(t0 + 2 * minute, client);
		await run(t0 + 4 * minute, client);
		const id = (await sub())?.id;
		for (let i = 0; i < 3; i += 1)
			await relayCall(
				"POST",
				"/api/claude-env/relay/v1/report",
				{
					report_id: `bad-${i}`,
					relay_id: "r1",
					results: [
						{
							id,
							applied: true,
							exit_ip: "1.1.1.1",
							exit_ok: false,
							anthropic_status: 403,
						},
					],
				},
				t0 + (5 + i) * minute,
			);
		expect((await sub())?.status).toBe("needs_replace");
		expect(messages.filter((m) => m.includes("IP 质检不合格"))).toHaveLength(1);
	});

	it("renewal extends the same subscription and IP and calls IPRoyal extend once", async () => {
		const { client, calls } = fakeIproyal();
		await provision(client);
		await run(t0 + 6 * minute, client);
		const before = await sub();
		await insertOrder({
			id: "o2",
			userId: "u1",
			sku: quarterlySku,
			paidAt: t0 + 10 * minute,
		});
		await run(t0 + 11 * minute, client);
		await run(t0 + 12 * minute, client);
		const after = await sub();
		const count = await db
			.prepare("SELECT COUNT(*) AS n FROM claude_env_subscriptions")
			.first<{ n: number }>();
		expect(count?.n).toBe(1);
		expect(after?.ip).toBe(before?.ip);
		expect(after?.expires_at).toBe(before?.expires_at + 90 * dayMs);
		expect(calls.create).toBe(1);
		expect(calls.extend).toEqual([["4242", 25]]);
		expect(messages.some((m) => m.includes("续费"))).toBe(true);
		// The renewal order also opens the panel for the same subscription.
		expect(
			await loadClaudeEnvPanel(db, "u1", "GMO2", t0 + 12 * minute),
		).toMatchObject({ ip: "161.77.8.204" });
	});

	it("renewal during grace reactivates; expiry moves active → grace → expired", async () => {
		const { client } = fakeIproyal();
		await provision(client);
		await run(t0 + 6 * minute, client);
		const expires = (await sub())?.expires_at as number;
		await run(expires + 1, client);
		expect((await sub())?.status).toBe("grace");
		await run(expires + 3 * dayMs + 1, client);
		expect((await sub())?.status).toBe("expired");
		const desired = await relayCall(
			"GET",
			"/api/claude-env/relay/v1/desired",
			undefined,
			expires + 3 * dayMs + 2,
		);
		expect(desired.json.customers).toEqual([]);
	});

	it("accumulates traffic per report_id and alerts once at 80% of the relay quota", async () => {
		const { client } = fakeIproyal();
		const id = await provision(client);
		await run(t0 + 6 * minute, client);
		const report = (reportId: string, up: number, down: number, rx: number) =>
			relayCall(
				"POST",
				"/api/claude-env/relay/v1/report",
				{
					report_id: reportId,
					relay_id: "r1",
					results: [],
					traffic: [{ id, up_bytes: up, down_bytes: down }],
					host: { month: "2026-10", rx_bytes: rx, tx_bytes: 0 },
				},
				t0 + 10 * minute,
			);
		await report("t-1", 100, 200, 700);
		await report("t-2", 10, 20, 850);
		await report("t-1", 100, 200, 700); // resent duplicate: ignored
		await report("t-3", 0, 0, 900);
		const row = await sub();
		expect(row?.traffic_period_bytes).toBe(330);
		const relay = await db
			.prepare("SELECT * FROM claude_env_relays WHERE id='r1'")
			.first<Record<string, any>>();
		expect(relay).toMatchObject({
			host_month: "2026-10",
			host_rx_bytes: 900,
			quota_alert_month: "2026-10",
		});
		expect(messages.filter((m) => m.includes("中转机 r1 本月"))).toHaveLength(
			1,
		);
	});

	it("rejects unknown relays, stale timestamps and bad signatures", async () => {
		const now = t0;
		expect(
			(
				await relayCall(
					"GET",
					"/api/claude-env/relay/v1/desired",
					undefined,
					now,
					{ relayId: "r9" },
				)
			).status,
		).toBe(401);
		expect(
			(
				await relayCall(
					"GET",
					"/api/claude-env/relay/v1/desired",
					undefined,
					now,
					{ skewSeconds: 301 },
				)
			).status,
		).toBe(401);
		expect(
			(
				await relayCall(
					"GET",
					"/api/claude-env/relay/v1/desired",
					undefined,
					now,
					{ skewSeconds: -300 },
				)
			).status,
		).toBe(200);
		expect(
			(
				await relayCall(
					"GET",
					"/api/claude-env/relay/v1/desired",
					undefined,
					now,
					{ secret: "f".repeat(64) },
				)
			).status,
		).toBe(401);
		const mismatch = await relayCall(
			"POST",
			"/api/claude-env/relay/v1/report",
			{ report_id: "x", relay_id: "r2", results: [] },
			now,
		);
		expect(mismatch.status).toBe(400);
	});

	it("alerts on balance shortfall and never posts an order twice after an unknown outcome", async () => {
		const short = fakeIproyal({ balance: async () => 1 });
		await enable();
		await run(t0, short.client);
		await insertOrder({
			id: "o1",
			userId: "u1",
			sku: monthlySku,
			paidAt: t0 + 1,
		});
		await run(t0 + 2000, short.client);
		expect(short.calls.create).toBe(0);
		expect(messages.some((m) => m.includes("IPRoyal 余额不足"))).toBe(true);

		let posts = 0;
		const flaky = fakeIproyal({
			createOrder: async () => {
				posts += 1;
				throw new IproyalError("iproyal_unreachable", null, false);
			},
		});
		await run(t0 + 20 * minute, flaky.client);
		await run(t0 + 40 * minute, flaky.client);
		expect(posts).toBe(1);
		expect((await sub())?.iproyal_order_state).toBe("unknown");
		expect(messages.some((m) => m.includes("下单结果不明"))).toBe(true);
		await applySubscriptionAction(
			{ db, crypt: await loadCrypt(db) },
			{ userId: "u1" },
			{
				action: "set_iproyal_order",
				id: (await sub())?.id,
				iproyalOrderId: "777",
			},
			t0 + 41 * minute,
		);
		expect(await sub()).toMatchObject({
			iproyal_order_state: "ordered",
			iproyal_order_id: "777",
		});
	});

	it("alerts when there is no relay capacity or no IPRoyal token", async () => {
		await db.prepare("UPDATE claude_env_relays SET max_customers = 0").run();
		await enable();
		await run(t0, undefined);
		await insertOrder({
			id: "o1",
			userId: "u1",
			sku: monthlySku,
			paidAt: t0 + 1,
		});
		await run(t0 + 2000, undefined);
		expect(messages.some((m) => m.includes("中转机满了"))).toBe(true);
		await db.prepare("UPDATE claude_env_relays SET max_customers = 10").run();
		await run(t0 + 10 * minute, undefined);
		expect(messages.some((m) => m.includes("IPROYAL_API_TOKEN"))).toBe(true);
		expect((await sub())?.status).toBe("awaiting_ip");
	});

	it("skips agent-site (supplier API) orders and cancels refunded orders before purchase", async () => {
		await enable();
		await run(t0, undefined);
		await insertOrder({
			id: "api1",
			userId: "agent",
			sku: monthlySku,
			paidAt: t0 + 1,
		});
		await db.batch([
			db.prepare(
				"INSERT INTO supplier_api_keys (id, user_id, name, key_id, secret_encrypted) VALUES ('k1','agent','n','kid','s')",
			),
			db.prepare(
				"INSERT INTO supplier_api_orders (id, shop_order_id, user_id, api_key_id, downstream_order_no, request_digest, created_at, updated_at) VALUES ('sa1','api1','agent','k1','d1','x',1,1)",
			),
		]);
		await insertOrder({
			id: "o1",
			userId: "u1",
			sku: monthlySku,
			paidAt: t0 + 2,
			status: "refunded",
		});
		await insertOrder({
			id: "o3",
			userId: "u2",
			sku: monthlySku,
			paidAt: t0 + 3,
			email: "other@example.com",
		});
		await run(t0 + 2000, undefined);
		expect(messages.some((m) => m.includes("代理站"))).toBe(true);
		await db
			.prepare("UPDATE shop_orders SET status='refunded' WHERE id='o3'")
			.run();
		await run(t0 + 3000, undefined);
		const rows = await db
			.prepare("SELECT user_id, status FROM claude_env_subscriptions")
			.all();
		expect(rows.results).toEqual([{ user_id: "u2", status: "cancelled" }]);
	});
});
