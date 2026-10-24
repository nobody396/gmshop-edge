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
	setClaudeEnvEnabled,
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
/** IPRoyal's expire_date for the first purchase in these tests. */
const iproyalExpiry = t0 + 30 * dayMs + 7 * minute;

// biome-ignore lint/suspicious/noExplicitAny: D1 rows in assertions
type Row = Record<string, any>;

function fakeIproyal(overrides: Partial<IproyalClient> = {}) {
	const calls = { create: 0, extend: [] as Array<[string, number]> };
	const state = {
		delivered: false,
		ip: "161.77.8.204",
		expiresAt: iproyalExpiry as number | null,
	};
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
			if (!state.delivered) {
				state.delivered = true;
				return { proxy: null, expiresAt: state.expiresAt };
			}
			return {
				proxy: {
					ip: state.ip,
					port: 12323,
					username: "up-user",
					password: "up-pass",
					location: "United States",
				},
				expiresAt: state.expiresAt,
			};
		},
		extendOrder: async (id, plan) => {
			calls.extend.push([id, plan]);
			if (state.expiresAt !== null)
				state.expiresAt += (plan === 25 ? 90 : 30) * dayMs;
		},
		...overrides,
	};
	return { client, calls, state };
}

function qualityFetcher(trust: number, scam: number, tz = "America/New_York") {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.startsWith("https://ip.net.coffee/"))
			return Response.json({ trust_score: trust });
		if (url.startsWith("https://scamalytics.com/"))
			return new Response(`<div>Fraud Score: ${scam}</div>`);
		if (url.startsWith("http://ip-api.com/"))
			return Response.json({ status: "success", timezone: tz });
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

	const enable = (now = t0) =>
		setClaudeEnvEnabled(db, { userId: "u1" }, true, now);

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
		// biome-ignore lint/suspicious/noExplicitAny: response JSON in assertions
		return { status: response.status, json: (await response.json()) as any };
	}

	const report = (
		reportId: string,
		results: unknown[],
		now: number,
		extra: Record<string, unknown> = {},
	) =>
		relayCall(
			"POST",
			"/api/claude-env/relay/v1/report",
			{ report_id: reportId, relay_id: "r1", results, ...extra },
			now,
		);

	const okResult = (id: string, scam: number | null = null) => ({
		id,
		applied: true,
		error: null,
		exit_ip: "161.77.8.204",
		exit_ok: true,
		anthropic_status: 401,
		scam_score: scam,
	});

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
			.first<Row>();
	}

	async function period(orderItemId: string) {
		return db
			.prepare("SELECT * FROM claude_env_periods WHERE order_item_id = ?")
			.bind(orderItemId)
			.first<Row>();
	}

	/** Enable → ingest → buy → poll → relay self-test ok. Returns the subscription id. */
	async function provision(
		iproyal: IproyalClient,
		fetcher?: typeof fetch,
		scam: number | null = null,
	) {
		await enable();
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
		expect(
			await report("rep-1", [okResult(row?.id, scam)], t0 + 5 * minute),
		).toEqual({ status: 200, json: { ok: true } });
		return row?.id as string;
	}

	it("does nothing while the flag is off", async () => {
		await insertOrder({ id: "o1", userId: "u1", sku: monthlySku, paidAt: t0 });
		const { client, calls } = fakeIproyal();
		expect(await run(t0 + minute, client)).toEqual({ status: "disabled" });
		expect(calls.create).toBe(0);
		expect(await sub()).toBeNull();
	});

	it("provisions, quality-checks at the 80/40 boundary, takes IPRoyal's expiry and serves the panel only to the owner", async () => {
		const { client, calls } = fakeIproyal();
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
			user_id: "u1",
			relay_id: "r1",
			relay_port: 20000,
			ip: "161.77.8.204",
			ip_tz: "America/New_York",
			ip_city: "Springfield (Massachusetts)",
			iproyal_order_id: "4242",
			relay_check_ok: 1,
			expires_at: iproyalExpiry,
			iproyal_expires_at: iproyalExpiry,
		});
		expect(row?.ip_pass_encrypted).not.toContain("up-pass");
		expect(messages.some((m) => m.includes("新订单"))).toBe(true);

		const desired = await relayCall(
			"GET",
			"/api/claude-env/relay/v1/desired",
			undefined,
			t0 + 5 * minute,
		);
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
		expect(active?.expires_at).toBe(iproyalExpiry);
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
		expect(decodeActivationCode(revealed?.code ?? "")).toEqual({
			v: 1,
			host: "relay.example.com",
			port: 20000,
			user: row?.relay_user,
			pass: desired.json.customers[0].pass,
			ip: "161.77.8.204",
			tz: "America/New_York",
		});
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
	});

	it("prefers the relay-reported scam_score; falls back to the Worker fetch when it is null", async () => {
		const first = fakeIproyal();
		await provision(first.client, undefined, 41);
		// The Worker-side lookup would say 10, but the relay measured 41.
		await run(t0 + 6 * minute, first.client, qualityFetcher(98, 10));
		expect((await sub())?.status).toBe("needs_replace");
		expect((await sub())?.qc_scam_score).toBe(41);
	});

	it("falls back to the Worker scamalytics fetch when the relay sends null", async () => {
		const { client } = fakeIproyal();
		await provision(client, undefined, null);
		await run(t0 + 6 * minute, client, qualityFetcher(98, 41));
		expect((await sub())?.status).toBe("needs_replace");
	});

	it("needs_replace after 3 failed self-tests; alerts after 3 applied=false", async () => {
		const { client } = fakeIproyal();
		await enable();
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
			await report(
				`apply-${i}`,
				[{ id, applied: false, error: "xray_adi_failed" }],
				t0 + (5 + i) * minute,
			);
		expect(messages.filter((m) => m.includes("中转机加不上客户"))).toHaveLength(
			1,
		);
		for (let i = 0; i < 3; i += 1)
			await report(
				`bad-${i}`,
				[
					{
						id,
						applied: true,
						exit_ip: "1.1.1.1",
						exit_ok: false,
						anthropic_status: 403,
					},
				],
				t0 + (10 + i) * minute,
			);
		expect((await sub())?.status).toBe("needs_replace");
		expect(messages.filter((m) => m.includes("IP 质检不合格"))).toHaveLength(1);
	});

	it("renewal extends IPRoyal, keeps the IP and re-reads expire_date", async () => {
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
		const after = await sub();
		const count = await db
			.prepare("SELECT COUNT(*) AS n FROM claude_env_subscriptions")
			.first<{ n: number }>();
		expect(count?.n).toBe(1);
		expect(after?.ip).toBe(before?.ip);
		expect(after?.expires_at).toBe(iproyalExpiry + 90 * dayMs);
		expect(after?.iproyal_expires_at).toBe(iproyalExpiry + 90 * dayMs);
		expect(calls.create).toBe(1);
		expect(calls.extend).toEqual([["4242", 25]]);
		expect(messages.some((m) => m.includes("IPRoyal 已续期"))).toBe(true);
		expect(
			await loadClaudeEnvPanel(db, "u1", "GMO2", t0 + 12 * minute),
		).toMatchObject({ ip: "161.77.8.204" });
	});

	it("goes grace then expired at once when IPRoyal's own expiry has passed, and alerts", async () => {
		const { client } = fakeIproyal();
		await provision(client);
		await run(t0 + 6 * minute, client);
		await run(iproyalExpiry + 1, client);
		const row = await sub();
		expect(row?.status).toBe("expired");
		expect(row?.expired_at).toBe(iproyalExpiry + 1);
		expect(messages.some((m) => m.includes("IP 已失效"))).toBe(true);
		const desired = await relayCall(
			"GET",
			"/api/claude-env/relay/v1/desired",
			undefined,
			iproyalExpiry + 2,
		);
		expect(desired.json.customers).toEqual([]);
	});

	it("keeps grace for 3 days while IPRoyal still holds the IP (no re-read possible)", async () => {
		const { client } = fakeIproyal();
		await provision(client);
		await run(t0 + 6 * minute, client);
		await db
			.prepare(
				"UPDATE claude_env_subscriptions SET expires_at = ?, iproyal_expires_at = ?",
			)
			.bind(t0 + dayMs, t0 + 6 * dayMs)
			.run();
		await run(t0 + dayMs + 1, undefined);
		expect((await sub())?.status).toBe("grace");
		await run(t0 + 4 * dayMs + 1, undefined);
		expect((await sub())?.status).toBe("expired");
	});

	it("a renewal during grace reactivates once IPRoyal's new expiry is read back", async () => {
		const { client } = fakeIproyal();
		await provision(client);
		await run(t0 + 6 * minute, client);
		await db
			.prepare(
				"UPDATE claude_env_subscriptions SET status = 'grace', iproyal_expires_at = ?",
			)
			.bind(iproyalExpiry + dayMs)
			.run();
		await insertOrder({
			id: "o2",
			userId: "u1",
			sku: monthlySku,
			paidAt: iproyalExpiry + minute,
		});
		await run(iproyalExpiry + 2 * minute, client);
		expect(await sub()).toMatchObject({
			status: "active",
			expires_at: iproyalExpiry + 30 * dayMs,
		});
	});

	it("accumulates traffic per report_id and alerts once at 80% of the relay quota", async () => {
		const { client } = fakeIproyal();
		const id = await provision(client);
		await run(t0 + 6 * minute, client);
		const traffic = (reportId: string, up: number, down: number, rx: number) =>
			report(reportId, [], t0 + 10 * minute, {
				traffic: [{ id, up_bytes: up, down_bytes: down }],
				host: { month: "2026-10", rx_bytes: rx, tx_bytes: 0 },
			});
		await traffic("t-1", 100, 200, 700);
		await traffic("t-2", 10, 20, 850);
		await traffic("t-1", 100, 200, 700); // resent duplicate: ignored
		await traffic("t-3", 0, 0, 900);
		expect((await sub())?.traffic_period_bytes).toBe(330);
		const relay = await db
			.prepare("SELECT * FROM claude_env_relays WHERE id='r1'")
			.first<Row>();
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
		const path = "/api/claude-env/relay/v1/desired";
		expect(
			(await relayCall("GET", path, undefined, t0, { relayId: "r9" })).status,
		).toBe(401);
		expect(
			(await relayCall("GET", path, undefined, t0, { skewSeconds: 301 }))
				.status,
		).toBe(401);
		expect(
			(await relayCall("GET", path, undefined, t0, { skewSeconds: -300 }))
				.status,
		).toBe(200);
		expect(
			(await relayCall("GET", path, undefined, t0, { secret: "f".repeat(64) }))
				.status,
		).toBe(401);
		const mismatch = await relayCall(
			"POST",
			"/api/claude-env/relay/v1/report",
			{ report_id: "x", relay_id: "r2", results: [] },
			t0,
		);
		expect(mismatch.status).toBe(400);
	});

	it("flag off: desired still serves, reports record traffic but change no status", async () => {
		const { client } = fakeIproyal();
		await enable();
		await insertOrder({
			id: "o1",
			userId: "u1",
			sku: monthlySku,
			paidAt: t0 + 1,
		});
		await run(t0 + 2000, client);
		await run(t0 + 2 * minute, client);
		await run(t0 + 4 * minute, client);
		const id = (await sub())?.id as string;
		await setClaudeEnvEnabled(db, { userId: "u1" }, false, t0 + 5 * minute);
		const desired = await relayCall(
			"GET",
			"/api/claude-env/relay/v1/desired",
			undefined,
			t0 + 5 * minute,
		);
		expect(desired.json.customers).toHaveLength(1);
		for (let i = 0; i < 3; i += 1)
			await report(
				`off-${i}`,
				[{ id, applied: true, exit_ok: false, anthropic_status: 403 }],
				t0 + (6 + i) * minute,
				{ traffic: [{ id, up_bytes: 5, down_bytes: 5 }] },
			);
		const row = await sub();
		expect(row).toMatchObject({
			status: "provisioning",
			relay_check_ok: 0,
			relay_check_fail_streak: 0,
			traffic_total_bytes: 30,
		});
		expect(messages.some((m) => m.includes("质检不合格"))).toBe(false);
	});

	it("alerts once per 6h when the relay blocks a mass removal", async () => {
		const blocked = [
			{ id: "sub_a", applied: false, error: "mass_remove_blocked: 3 of 4" },
			{ id: "sub_b", applied: false, error: "mass_remove_blocked: 3 of 4" },
		];
		await report("m-1", blocked, t0);
		await report("m-2", blocked, t0 + minute);
		const alerts = messages.filter((m) =>
			m.includes("CE_SYNC_ALLOW_MASS_REMOVE=1 ce-relay sync"),
		);
		expect(alerts).toHaveLength(1);
		await report("m-3", blocked, t0 + 7 * 3_600_000);
		expect(
			messages.filter((m) => m.includes("CE_SYNC_ALLOW_MASS_REMOVE")),
		).toHaveLength(2);
	});

	describe("ingest window", () => {
		it("starts when the flag is switched on and never backfills orders paid while it was off", async () => {
			const { client } = fakeIproyal();
			await insertOrder({ id: "a", userId: "u1", sku: monthlySku, paidAt: t0 });
			await enable(t0 + minute);
			await run(t0 + 2 * minute, client);
			expect(await sub()).toBeNull();
			await setClaudeEnvEnabled(db, { userId: "u1" }, false, t0 + 3 * minute);
			await insertOrder({
				id: "b",
				userId: "u2",
				sku: monthlySku,
				paidAt: t0 + 4 * minute,
				email: "other@example.com",
			});
			await enable(t0 + 5 * minute);
			await run(t0 + 6 * minute, client);
			expect(await sub()).toBeNull();
			await insertOrder({
				id: "c",
				userId: "u2",
				sku: monthlySku,
				paidAt: t0 + 7 * minute,
				email: "other@example.com",
			});
			await run(t0 + 8 * minute, client);
			expect((await sub())?.order_id).toBe("c");
		});

		it("the cron never writes ingest_after itself", async () => {
			await db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES ('claude_env.automation_enabled','true',0,1,1)",
				)
				.run();
			await insertOrder({ id: "a", userId: "u1", sku: monthlySku, paidAt: t0 });
			const result = await run(t0 + minute, undefined);
			expect(result).toMatchObject({ ingested: "no_ingest_after" });
			expect(
				await db
					.prepare(
						"SELECT 1 FROM system_settings WHERE key = 'claude_env.ingest_after'",
					)
					.first(),
			).toBeNull();
		});
	});

	describe("guest orders", () => {
		it("park in waiting_registration, remind on day 1/3/7 only, and never block other orders", async () => {
			await enable();
			for (let i = 0; i < 21; i += 1)
				await insertOrder({
					id: `g${i}`,
					userId: null,
					sku: monthlySku,
					paidAt: t0 + i,
					email: `guest${i}@example.com`,
				});
			await insertOrder({
				id: "paid",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 100,
			});
			await run(t0 + minute, undefined);
			await run(t0 + 2 * minute, undefined);
			expect((await sub())?.order_id).toBe("paid");
			const reminders = () =>
				messages.filter((m) => m.includes("游客订单 GMG0（"));
			expect(reminders()).toHaveLength(1);
			await run(t0 + dayMs, undefined);
			expect(reminders()).toHaveLength(1);
			await run(t0 + 2 * dayMs + minute, undefined);
			expect(reminders()).toHaveLength(2);
			await run(t0 + 6 * dayMs + minute, undefined);
			await run(t0 + 20 * dayMs, undefined);
			expect(reminders()).toHaveLength(3);
			expect(reminders()[2]).toContain("第 3/3 次");
			// The guest verifies the order email → ingested automatically.
			await db
				.prepare(
					"INSERT INTO users (id, name, email, email_verified, enabled) VALUES ('g0user','G','guest0@example.com',1,1)",
				)
				.run();
			await run(t0 + 21 * dayMs, undefined);
			expect(await sub("user_id = 'g0user'")).toMatchObject({
				order_id: "g0",
				status: "awaiting_ip",
			});
			expect((await period("g0-item"))?.kind).toBe("initial");
		});
	});

	describe("IPRoyal order idempotency", () => {
		it("alerts on balance shortfall and never posts twice after an unknown outcome", async () => {
			const short = fakeIproyal({ balance: async () => 1 });
			await enable();
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
			expect(
				messages.filter((m) =>
					m.includes("先去 IPRoyal 后台核对有没有这一单，确认没有再点"),
				),
			).toHaveLength(1);
			// Too early: refused server-side.
			const id = (await sub())?.id;
			await expect(
				applySubscriptionAction(
					{ db, crypt: await loadCrypt(db) },
					{ userId: "u1" },
					{ action: "allow_reorder", id },
					t0 + 22 * minute,
				),
			).rejects.toThrow(/不到 5 分钟/);
			await applySubscriptionAction(
				{ db, crypt: await loadCrypt(db) },
				{ userId: "u1" },
				{ action: "allow_reorder", id },
				t0 + 26 * minute,
			);
			expect((await sub())?.iproyal_order_state).toBeNull();
		});

		it("treats a posting claim older than 5 minutes as unknown and alerts once", async () => {
			await enable();
			await insertOrder({
				id: "o1",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 1,
			});
			await run(t0 + 2000, undefined);
			await db
				.prepare(
					"UPDATE claude_env_subscriptions SET iproyal_order_state = 'posting', iproyal_posting_at = ?",
				)
				.bind(t0 + minute)
				.run();
			await run(t0 + 3 * minute, undefined);
			expect((await sub())?.iproyal_order_state).toBe("posting");
			await run(t0 + 7 * minute, undefined);
			await run(t0 + 8 * minute, undefined);
			expect((await sub())?.iproyal_order_state).toBe("unknown");
			expect(
				messages.filter((m) => m.includes("超过 5 分钟没有结果")),
			).toHaveLength(1);
		});

		it("alerts when the order succeeded but the posting claim was changed meanwhile", async () => {
			let changed = false;
			const racing = fakeIproyal({
				createOrder: async () => {
					changed = true;
					await db
						.prepare(
							"UPDATE claude_env_subscriptions SET iproyal_order_state = 'unknown'",
						)
						.run();
					return "999";
				},
			});
			await enable();
			await insertOrder({
				id: "o1",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 1,
			});
			await run(t0 + 2000, racing.client);
			expect(changed).toBe(true);
			expect((await sub())?.iproyal_order_id).toBeNull();
			expect(
				messages.some((m) => m.includes("订单 999") && m.includes("没有写回")),
			).toBe(true);
		});

		it("does not assign a non-IPv4 address", async () => {
			const { client, state } = fakeIproyal();
			state.ip = "2001:db8::1";
			await enable();
			await insertOrder({
				id: "o1",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 1,
			});
			await run(t0 + 2000, client);
			await run(t0 + 2 * minute, client);
			await run(t0 + 4 * minute, client);
			expect(await sub()).toMatchObject({ status: "awaiting_ip", ip: null });
			expect(messages.some((m) => m.includes("不是 IPv4"))).toBe(true);
		});

		it("stores a canonical US time zone", async () => {
			const { client } = fakeIproyal();
			await provision(
				client,
				qualityFetcher(98, 10, "America/Indiana/Indianapolis"),
			);
			expect((await sub())?.ip_tz).toBe("America/New_York");
		});
	});

	describe("IPRoyal extension idempotency", () => {
		it("keeps an unknown extension in `extending`; retry only once stale", async () => {
			const { client } = fakeIproyal({
				extendOrder: async () => {
					throw new IproyalError("iproyal_unreachable", null, false);
				},
			});
			await provision(client);
			await run(t0 + 6 * minute, client);
			await insertOrder({
				id: "o2",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 10 * minute,
			});
			await run(t0 + 11 * minute, client);
			expect((await period("o2-item"))?.extend_status).toBe("extending");
			expect(
				messages.filter((m) =>
					m.includes("先核对 IPRoyal 这张订单的到期时间有没有延长，再决定"),
				),
			).toHaveLength(1);
			await run(t0 + 20 * minute, client);
			expect(messages.filter((m) => m.includes("续期结果不明"))).toHaveLength(
				1,
			);
			await expect(
				applySubscriptionAction(
					{ db, crypt: await loadCrypt(db) },
					{ userId: "u1" },
					{ action: "period_retry", orderItemId: "o2-item" },
					t0 + 12 * minute,
				),
			).rejects.toThrow(/不到 5 分钟/);
			await applySubscriptionAction(
				{ db, crypt: await loadCrypt(db) },
				{ userId: "u1" },
				{ action: "period_retry", orderItemId: "o2-item" },
				t0 + 17 * minute,
			);
			expect((await period("o2-item"))?.extend_status).toBe("pending");
		});

		it("alerts once for an `extending` claim left behind by a crash", async () => {
			const { client } = fakeIproyal();
			await provision(client);
			await run(t0 + 6 * minute, client);
			await insertOrder({
				id: "o2",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 10 * minute,
			});
			// Simulate a crash between the claim and the IPRoyal call.
			await db.batch([
				db.prepare(
					"INSERT INTO claude_env_periods (order_item_id, order_id, subscription_id, kind, days, units, iproyal_plan_id, extend_status, extending_at, created_at, updated_at) SELECT 'o2-item', 'o2', id, 'renewal', 30, 1, 22, 'extending', 1, 1, 1 FROM claude_env_subscriptions",
				),
			]);
			await run(t0 + 11 * minute, client);
			await run(t0 + 12 * minute, client);
			expect(
				messages.filter((m) => m.includes("超过 5 分钟没有结果，订单 4242")),
			).toHaveLength(1);
		});
	});

	describe("manual IP swap and renewals without an order", () => {
		it("requires a new IPRoyal order id or an explicit same-order choice", async () => {
			const { client } = fakeIproyal();
			await provision(client);
			await run(t0 + 6 * minute, client, qualityFetcher(79, 10));
			const id = (await sub())?.id;
			const swap = {
				action: "replace_ip" as const,
				id,
				ip: "161.77.8.205",
				port: 12323,
				user: "n1",
				pass: "n2",
			};
			const deps = {
				db,
				crypt: await loadCrypt(db),
				fetcher: qualityFetcher(98, 10),
			};
			await expect(
				applySubscriptionAction(deps, { userId: "u1" }, swap, t0 + 8 * minute),
			).rejects.toThrow(/订单号/);
			await applySubscriptionAction(
				deps,
				{ userId: "u1" },
				{ ...swap, iproyalOrderId: "5555" },
				t0 + 8 * minute,
			);
			expect(await sub()).toMatchObject({
				status: "provisioning",
				ip: "161.77.8.205",
				iproyal_order_id: "5555",
				expire_sync_needed: 1,
			});
		});

		it("does not extend the old order while waiting for a new IP, and says so", async () => {
			const { client, calls } = fakeIproyal();
			await provision(client);
			await run(t0 + 6 * minute, client, qualityFetcher(79, 10));
			await insertOrder({
				id: "o2",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 10 * minute,
			});
			await run(t0 + 11 * minute, client);
			expect(calls.extend).toEqual([]);
			expect((await period("o2-item"))?.extend_status).toBe("pending");
			expect(
				messages.some((m) => m.includes("不会对旧 IPRoyal 订单续期")),
			).toBe(true);
		});

		it("alerts instead of silently skipping a renewal for a subscription without an IPRoyal order", async () => {
			const { client } = fakeIproyal();
			await provision(client);
			await run(t0 + 6 * minute, client);
			await db
				.prepare("UPDATE claude_env_subscriptions SET iproyal_order_id = NULL")
				.run();
			await insertOrder({
				id: "o2",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 10 * minute,
			});
			await run(t0 + 11 * minute, client);
			expect((await period("o2-item"))?.extend_status).toBe("failed");
			expect(messages.some((m) => m.includes("没有 IPRoyal 订单号"))).toBe(
				true,
			);
			const before = (await sub())?.expires_at;
			await applySubscriptionAction(
				{ db, crypt: await loadCrypt(db) },
				{ userId: "u1" },
				{ action: "period_done", orderItemId: "o2-item" },
				t0 + 12 * minute,
			);
			expect((await sub())?.expires_at).toBe(before + 30 * dayMs);
		});
	});

	describe("refunds", () => {
		it("skips agent-site orders and cancels refunded orders before purchase", async () => {
			await enable();
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

		it("alerts when a refund loses the race against a purchase that just started", async () => {
			await enable();
			await insertOrder({
				id: "o1",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 1,
			});
			await run(t0 + 2000, undefined);
			await db
				.prepare("UPDATE shop_orders SET status='refunded' WHERE id='o1'")
				.run();
			// The purchase claims the posting slot between our read and the cancel.
			const racing = new Proxy(db, {
				get(target, key) {
					if (key === "batch")
						return async (statements: D1PreparedStatement[]) => {
							await target
								.prepare(
									"UPDATE claude_env_subscriptions SET iproyal_order_state = 'posting', iproyal_posting_at = ?",
								)
								.bind(t0 + 2500)
								.run();
							return target.batch(statements);
						};
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			await runClaudeEnv({
				db: racing,
				now: t0 + 3000,
				deliver,
				fetcher: qualityFetcher(98, 10),
			});
			expect(
				messages.some((m) => m.includes("退款单可能已买了 IP，请人工处理")),
			).toBe(true);
			expect((await sub())?.status).toBe("suspended");
		});

		it("cancels a refunded renewal that IPRoyal has not extended yet, alerts when it already has", async () => {
			const { client } = fakeIproyal();
			await enable();
			await insertOrder({
				id: "o1",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 1,
			});
			await run(t0 + 2000, undefined);
			await insertOrder({
				id: "o2",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 3000,
			});
			await run(t0 + 4000, undefined);
			await db
				.prepare("UPDATE shop_orders SET status='refunded' WHERE id='o2'")
				.run();
			await run(t0 + 5000, undefined);
			expect((await period("o2-item"))?.extend_status).toBe("cancelled");
			expect(messages.some((m) => m.includes("已取消这次续期"))).toBe(true);

			// Already extended at IPRoyal → owner decides.
			await run(t0 + 2 * minute, client);
			await run(t0 + 4 * minute, client);
			await report("ok", [okResult((await sub())?.id)], t0 + 5 * minute);
			await run(t0 + 6 * minute, client);
			await insertOrder({
				id: "o3",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 7 * minute,
			});
			await run(t0 + 8 * minute, client);
			expect((await period("o3-item"))?.extend_status).toBe("done");
			await db
				.prepare("UPDATE shop_orders SET status='refunded' WHERE id='o3'")
				.run();
			await run(t0 + 9 * minute, client);
			expect((await period("o3-item"))?.refund_handled).toBe(1);
			expect(
				messages.some((m) => m.includes("GMO3 已退款，但 IPRoyal 已经续期")),
			).toBe(true);
		});
	});

	describe("relay slots", () => {
		it("alerts when there is no relay capacity or no IPRoyal token", async () => {
			await db.prepare("UPDATE claude_env_relays SET max_customers = 0").run();
			await enable();
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

		it("reuses a port only after its customer has been expired for 30 days", async () => {
			await db.batch([
				db
					.prepare(
						`INSERT INTO claude_env_subscriptions (id, user_id, email, order_id, order_item_id, plan, status, relay_id, relay_port,
					 iproyal_plan_id, expired_at, created_at, updated_at)
					 VALUES ('sub_old','u2','other@example.com','x','x-item','monthly','expired','r1',20000,22,?,1,1),
					        ('sub_new','u2','other@example.com','y','y-item','monthly','expired','r1',20001,22,?,1,1)`,
					)
					.bind(t0 - 31 * dayMs, t0 - 10 * dayMs),
			]);
			await enable();
			await insertOrder({
				id: "o1",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 1,
			});
			await run(t0 + 2000, undefined);
			expect((await sub("user_id = 'u1'"))?.relay_port).toBe(20000);
			expect((await sub("id = 'sub_old'"))?.relay_port).toBeNull();
			expect((await sub("id = 'sub_new'"))?.relay_port).toBe(20001);
		});
	});
});
