import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	claudeEnvProductId,
	claudeEnvTrafficProductId,
	dayMs,
	decodeActivationCode,
	signRelayRequest,
} from "#/features/claude-env/domain";
import {
	applySubscriptionAction,
	loadClaudeEnvAdmin as loadAdmin,
	saveRelay,
	setClaudeEnvEnabled,
} from "#/features/claude-env/server/admin-actions";
import {
	enqueueClaudeEnvTrafficEmail,
	renderClaudeEnvTrafficEmail,
	type SendExpiryEmail,
	type SendTrafficEmail,
} from "#/features/claude-env/server/customer-email";
import type { IproyalClient } from "#/features/claude-env/server/iproyal";
import { IproyalError } from "#/features/claude-env/server/iproyal";
import {
	loadClaudeEnvPanel,
	revealClaudeEnvCode,
} from "#/features/claude-env/server/panel";
import { reconcileIproyalOrders } from "#/features/claude-env/server/reconcile";
import { handleRelayApiRequest } from "#/features/claude-env/server/relay-api";
import { sendExpiryReminders } from "#/features/claude-env/server/reminders";
import {
	activateReady,
	runClaudeEnv,
} from "#/features/claude-env/server/scheduler";
import { loadCrypt } from "#/features/claude-env/server/shared";
import { ingestTrafficForOrder } from "#/features/claude-env/server/traffic";
import { handleClaudeEnvTrafficOps } from "#/features/claude-env/server/traffic-api";
import { supportReplyEmailSender } from "#/features/notifications/server/delivery";
import { recipientHash } from "#/features/notifications/server/recipient-policy";
import { listIndexedProducts } from "#/features/seo/server/site-index";
import { applyMigrations } from "./migrations";

const relaySecret =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const monthlySku = "c3bab030-0c3c-4451-9c41-3cc32538e778";
const quarterlySku = "1e599d3a-3aa2-498e-a955-f4b04a4abdc4";
const t0 = Date.parse("2026-10-24T00:00:00Z");
const minute = 60_000;
const hour = 60 * minute;
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
		listOrders: async () => [],
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
		productId?: string;
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
					input.productId ?? claudeEnvProductId,
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
		options: {
			secret?: string;
			relayId?: string;
			skewSeconds?: number;
			onReady?: () => Promise<unknown>;
		} = {},
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
			{ db, now, deliver, onReady: options.onReady },
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
	) =>
		runClaudeEnv({
			db,
			now,
			iproyal,
			fetcher,
			deliver,
			sendCustomerEmail,
			sleep: async () => undefined,
		});

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

	it("receives the IP in the same tick it was ordered", async () => {
		const { client, calls } = fakeIproyal();
		const getOrder = vi.fn(client.getOrder);
		await enable();
		await insertOrder({
			id: "o1",
			userId: "u1",
			sku: monthlySku,
			paidAt: t0 + 1000,
		});
		await run(t0 + 2000, { ...client, getOrder });
		expect(calls.create).toBe(1);
		// First poll: not assigned yet; second poll (5 s later) has the IP.
		expect(getOrder).toHaveBeenCalledTimes(2);
		expect(await sub()).toMatchObject({
			status: "provisioning",
			ip: "161.77.8.204",
		});
	});

	it("activates and emails as soon as the relay reports a passing self-test", async () => {
		const { client } = fakeIproyal();
		await enable();
		await insertOrder({
			id: "o1",
			userId: "u1",
			sku: monthlySku,
			paidAt: t0 + 1000,
		});
		await run(t0 + 2000, client);
		const row = await sub();
		expect(row?.status).toBe("provisioning");
		const sendCustomerEmail = vi.fn(async () => undefined);
		const now = t0 + 30_000;
		await relayCall(
			"POST",
			"/api/claude-env/relay/v1/report",
			{ report_id: "rep-fast", relay_id: "r1", results: [okResult(row?.id)] },
			now,
			{
				onReady: () =>
					activateReady({
						db,
						now,
						fetcher: qualityFetcher(98, 32),
						deliver,
						sendCustomerEmail,
					}),
			},
		);
		expect((await sub())?.status).toBe("active");
		expect(sendCustomerEmail).toHaveBeenCalledTimes(1);
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

	describe("expiry: no grace period", () => {
		it("expires the moment expires_at passes, alerts once and drops out of the relay list", async () => {
			const { client } = fakeIproyal();
			const id = await provision(client);
			await run(t0 + 6 * minute, client);
			await run(iproyalExpiry - 1, client);
			expect((await sub())?.status).toBe("active");
			await run(iproyalExpiry, client);
			const row = await sub();
			expect(row?.status).toBe("expired");
			expect(row?.expired_at).toBe(iproyalExpiry);
			await run(iproyalExpiry + minute, client);
			expect(
				messages.filter((m) =>
					m.includes("已到期停用：bu****@example.com 161.77.8.204"),
				),
			).toHaveLength(1);
			const desired = await relayCall(
				"GET",
				"/api/claude-env/relay/v1/desired",
				undefined,
				iproyalExpiry + 2,
			);
			expect(desired.json.customers).toEqual([]);
			const panel = await loadClaudeEnvPanel(
				db,
				"u1",
				"GMO1",
				iproyalExpiry + 2,
			);
			expect(panel).toMatchObject({
				status: "expired",
				ip: null,
				codeAvailable: false,
				expiringSoon: false,
			});
			expect(
				await revealClaudeEnvCode(db, await loadCrypt(db), "u1", "GMO1"),
			).toBeNull();
			const deps = { db, crypt: await loadCrypt(db) };
			for (const action of [
				{ action: "resume" as const, id },
				{ action: "extend_days" as const, id, days: 30 },
				{ action: "suspend" as const, id },
			])
				await expect(
					applySubscriptionAction(
						deps,
						{ userId: "u1" },
						action,
						iproyalExpiry + 3,
					),
				).rejects.toThrow(
					action.action === "suspend"
						? /不能暂停/
						: /IP 已随 IPRoyal 订单到期释放，不能恢复/,
				);
			expect((await sub())?.status).toBe("expired");
		});

		it("an admin-suspended subscription past its expiry also expires and cannot be resumed", async () => {
			const { client } = fakeIproyal();
			const id = await provision(client);
			await run(t0 + 6 * minute, client);
			const deps = { db, crypt: await loadCrypt(db) };
			await applySubscriptionAction(
				deps,
				{ userId: "u1" },
				{ action: "suspend", id },
				t0 + 7 * minute,
			);
			await expect(
				applySubscriptionAction(
					deps,
					{ userId: "u1" },
					{ action: "resume", id },
					iproyalExpiry,
				),
			).rejects.toThrow(/不能恢复/);
			await run(iproyalExpiry, client);
			expect(await sub()).toMatchObject({
				status: "expired",
				status_before_suspend: null,
			});
		});

		it("a purchase after expiry is a brand-new subscription with a new IP, never a renewal", async () => {
			const { client, calls } = fakeIproyal();
			await provision(client);
			await run(t0 + 6 * minute, client);
			await run(iproyalExpiry, client);
			await insertOrder({
				id: "o2",
				userId: "u1",
				sku: monthlySku,
				paidAt: iproyalExpiry + minute,
			});
			await run(iproyalExpiry + 2 * minute, client);
			const rows = await db
				.prepare(
					"SELECT id, status, order_id FROM claude_env_subscriptions ORDER BY created_at",
				)
				.all<Row>();
			expect(rows.results).toHaveLength(2);
			expect(rows.results[0]).toMatchObject({ status: "expired" });
			expect(rows.results[1]).toMatchObject({ order_id: "o2" });
			expect(await period("o2-item")).toMatchObject({ kind: "initial" });
			expect(calls.extend).toEqual([]);
			expect(calls.create).toBe(2);
		});

		it("a paid renewal IPRoyal never extended is cancelled at expiry and flagged for a refund", async () => {
			const { client, calls } = fakeIproyal({
				extendOrder: async () => {
					throw new IproyalError("iproyal_http_402", 402, true);
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
			expect(await period("o2-item")).toMatchObject({
				kind: "renewal",
				extend_status: "failed",
			});
			await run(iproyalExpiry, client);
			expect((await sub())?.status).toBe("expired");
			expect(await period("o2-item")).toMatchObject({
				extend_status: "cancelled",
				note: "expired_before_extend",
			});
			expect(
				messages.some(
					(m) => m.includes("续费单 GMO2") && m.includes("请人工退款"),
				),
			).toBe(true);
			expect(calls.create).toBe(1);
		});
	});

	describe("expiry reminders (7 / 5 / 3 days)", () => {
		const remindersFor = (subscriptionId: string) =>
			db
				.prepare(
					"SELECT * FROM claude_env_reminders WHERE subscription_id = ? ORDER BY created_at, point DESC",
				)
				.bind(subscriptionId)
				.all<Row>()
				.then((r) => r.results);

		async function activeSubscription() {
			const fake = fakeIproyal();
			const id = await provision(fake.client);
			await run(t0 + 6 * minute, fake.client);
			expect((await sub())?.status).toBe("active");
			return { id, ...fake };
		}

		const emailSpy = () =>
			vi.fn<SendExpiryEmail>(async () => ({
				status: "queued",
				deliveryId: "d",
			}));

		it("sends each point exactly once with the right N, Beijing time and a single −3d owner alert", async () => {
			const { id, client } = await activeSubscription();
			const email = emailSpy();
			const at = (now: number) =>
				runClaudeEnv({
					db,
					now,
					iproyal: client,
					fetcher: qualityFetcher(98, 32),
					deliver,
					sendCustomerEmail: vi.fn(async () => undefined),
					sendExpiryEmail: email,
				});
			await at(iproyalExpiry - 7 * dayMs - minute);
			expect(email).not.toHaveBeenCalled();
			await at(iproyalExpiry - 7 * dayMs + minute);
			await at(iproyalExpiry - 6 * dayMs);
			await at(iproyalExpiry - 5 * dayMs + minute);
			await at(iproyalExpiry - 5 * dayMs + 2 * minute);
			await at(iproyalExpiry - 3 * dayMs + minute);
			await at(iproyalExpiry - 3 * dayMs + 10 * minute);
			await at(iproyalExpiry - dayMs);
			expect(
				email.mock.calls.map(([, input]) => [input.point, input.daysLeft]),
			).toEqual([
				[7, 7],
				[5, 5],
				[3, 3],
			]);
			expect(email.mock.calls[0]?.[1]).toMatchObject({
				subscriptionId: id,
				to: "buyer1@example.com",
				recipientKind: "account",
				expiresAt: iproyalExpiry,
				plan: "monthly",
				locale: "zh-CN",
			});
			const rows = await remindersFor(id);
			expect(rows.map((r) => [r.point, r.status, r.owner_alerted])).toEqual([
				[7, "sent", 0],
				[5, "sent", 0],
				[3, "sent", 1],
			]);
			const owner = messages.filter((m) =>
				m.includes("天到期（客户还没续费）"),
			);
			expect(owner).toHaveLength(1);
			// 2026-11-23T00:07Z = 2026-11-23 08:07 Beijing.
			expect(owner[0]).toContain("还有 3 天到期");
			expect(owner[0]).toContain("bu****@example.com");
			expect(owner[0]).toContain("161.77.8.204");
			expect(owner[0]).toContain("到期 2026-11-23 08:07 北京时间");
		});

		it("overlapping cron runs claim a point only once", async () => {
			const { id } = await activeSubscription();
			const email = emailSpy();
			const now = iproyalExpiry - 3 * dayMs + minute;
			await Promise.all(
				[0, 1, 2].map(() =>
					sendExpiryReminders({ db, now, deliver, sendEmail: email }),
				),
			);
			expect(email).toHaveBeenCalledTimes(1);
			expect(await remindersFor(id)).toHaveLength(1);
			expect(
				messages.filter((m) => m.includes("天到期（客户还没续费）")),
			).toHaveLength(1);
		});

		it("renewal moves the date: the old date's reminders are void and the new date's apply", async () => {
			const { id, client } = await activeSubscription();
			const email = emailSpy();
			const at = (now: number) =>
				runClaudeEnv({
					db,
					now,
					iproyal: client,
					fetcher: qualityFetcher(98, 32),
					deliver,
					sendCustomerEmail: vi.fn(async () => undefined),
					sendExpiryEmail: email,
				});
			await at(iproyalExpiry - 7 * dayMs + minute);
			expect(email).toHaveBeenCalledTimes(1);
			await insertOrder({
				id: "o2",
				userId: "u1",
				sku: monthlySku,
				paidAt: iproyalExpiry - 6 * dayMs,
			});
			await at(iproyalExpiry - 6 * dayMs + minute);
			const renewed = iproyalExpiry + 30 * dayMs;
			expect((await sub())?.expires_at).toBe(renewed);
			await at(iproyalExpiry - 5 * dayMs + minute);
			await at(iproyalExpiry - 3 * dayMs + minute);
			expect(email).toHaveBeenCalledTimes(1);
			await at(renewed - 7 * dayMs + minute);
			expect(email).toHaveBeenCalledTimes(2);
			expect(email.mock.calls[1]?.[1]).toMatchObject({
				point: 7,
				daysLeft: 7,
				expiresAt: renewed,
			});
			expect(
				(await remindersFor(id)).map((r) => [r.expires_at, r.point]),
			).toEqual([
				[iproyalExpiry, 7],
				[renewed, 7],
			]);
		});

		it("entering the window late sends only the nearest point once (no backfill burst)", async () => {
			const { id } = await activeSubscription();
			const now = t0 + dayMs;
			await db
				.prepare("UPDATE claude_env_subscriptions SET expires_at = ?")
				.bind(now + 4 * dayMs)
				.run();
			const email = emailSpy();
			await sendExpiryReminders({ db, now, deliver, sendEmail: email });
			await sendExpiryReminders({
				db,
				now: now + hour,
				deliver,
				sendEmail: email,
			});
			expect(
				email.mock.calls.map(([, input]) => [input.point, input.daysLeft]),
			).toEqual([[5, 4]]);
			await sendExpiryReminders({
				db,
				now: now + dayMs + minute,
				deliver,
				sendEmail: email,
			});
			expect(email.mock.calls.map(([, input]) => input.point)).toEqual([5, 3]);
			expect(await remindersFor(id)).toHaveLength(2);
		});

		it("sends nothing for expired, needs_replace or suspended subscriptions", async () => {
			const { id } = await activeSubscription();
			const now = iproyalExpiry - 3 * dayMs + minute;
			const email = emailSpy();
			for (const status of ["needs_replace", "suspended", "expired"]) {
				await db
					.prepare("UPDATE claude_env_subscriptions SET status = ?")
					.bind(status)
					.run();
				await sendExpiryReminders({ db, now, deliver, sendEmail: email });
			}
			expect(email).not.toHaveBeenCalled();
			expect(await remindersFor(id)).toEqual([]);
			expect(messages.some((m) => m.includes("天到期（客户还没续费）"))).toBe(
				false,
			);
		});

		it("real sender: skipped and recorded without the approved channel; queued to account + order email when configured", async () => {
			const { id } = await activeSubscription();
			await db.batch([
				db.prepare(
					"UPDATE users SET email = 'buyer@mail-buyer.cn' WHERE id = 'u1'",
				),
				db.prepare(
					"UPDATE shop_orders SET normalized_contact_email = 'contact@mail-buyer.cn', locale = 'en-US' WHERE id = 'o1'",
				),
			]);
			await sendExpiryReminders({
				db,
				now: iproyalExpiry - 7 * dayMs + minute,
				deliver,
			});
			const [skipped] = await remindersFor(id);
			expect(skipped).toMatchObject({ point: 7, status: "skipped" });
			expect(JSON.parse(skipped?.detail)).toEqual([
				{
					recipient: "account",
					status: "skipped",
					reason: "sender_unavailable",
				},
				{ recipient: "order", status: "skipped", reason: "sender_unavailable" },
			]);
			const none = await db
				.prepare("SELECT COUNT(*) AS n FROM notification_deliveries")
				.first<{ n: number }>();
			expect(none?.n).toBe(0);

			await db
				.prepare(
					"INSERT INTO notification_channel_configs (id,channel,name,provider,from_address,enabled) VALUES ('official','email','Official','cloudflare_email',?,1)",
				)
				.bind(supportReplyEmailSender)
				.run();
			await db
				.prepare(
					"INSERT INTO email_unsubscribes (recipient_hash, scope, created_at) VALUES (?, 'renewal', 1)",
				)
				.bind(await recipientHash("contact@mail-buyer.cn"))
				.run();
			await sendExpiryReminders({
				db,
				now: iproyalExpiry - 5 * dayMs + minute,
				deliver,
			});
			const sent = (await remindersFor(id)).find((r) => r.point === 5);
			expect(sent).toMatchObject({ status: "sent", locale: "en-US" });
			expect(
				JSON.parse(sent?.detail).map((r: Row) => [r.recipient, r.status]),
			).toEqual([
				["account", "queued"],
				["order", "unsubscribed"],
			]);
			const deliveries = await db
				.prepare(
					"SELECT event, channel_config_id, status, locale, idempotency_key FROM notification_deliveries",
				)
				.all<Row>();
			expect(deliveries.results).toEqual([
				{
					event: "claude_env_expiring",
					channel_config_id: "official",
					status: "pending",
					locale: "en-US",
					idempotency_key: expect.stringMatching(
						new RegExp(`^claude-env-expiry:${id}:${iproyalExpiry}:5:`),
					),
				},
			]);
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

	describe("IPRoyal purchase audit", () => {
		const events = async () =>
			(
				await db
					.prepare(
						"SELECT kind, detail FROM claude_env_events WHERE kind <> 'created' ORDER BY created_at, rowid",
					)
					.all<Row>()
			).results;

		it("records the purchase attempt before calling IPRoyal, in the claim batch", async () => {
			let seenDuringCall: Row[] = [];
			const { client } = fakeIproyal({
				createOrder: async () => {
					seenDuringCall = await events();
					return "4242";
				},
			});
			await enable();
			await insertOrder({
				id: "o1",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 1000,
			});
			await run(t0 + 2000, client);
			const id = (await sub())?.id;
			expect(seenDuringCall).toEqual([
				{
					kind: "ip_order_posting",
					detail: `gmshop:${id} Springfield (Massachusetts) plan 22 $5.20 balance $100.00`,
				},
			]);
			// The attempt comes first, then the result (then IP delivery events).
			expect((await events()).map((e) => e.kind).slice(0, 2)).toEqual([
				"ip_order_posting",
				"ip_ordered",
			]);
		});

		it("keeps the attempt trace when the call dies mid-way", async () => {
			const { client } = fakeIproyal({
				createOrder: async () => {
					throw new IproyalError("iproyal_unreachable", null, false);
				},
			});
			await enable();
			await insertOrder({
				id: "o1",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 1000,
			});
			await run(t0 + 2000, client);
			expect((await events()).map((e) => e.kind)).toEqual([
				"ip_order_posting",
				"order_unknown",
			]);
		});

		it("writes no attempt event when the claim is lost", async () => {
			const { client, calls } = fakeIproyal();
			await enable();
			await insertOrder({
				id: "o1",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 1000,
			});
			const original = client.balance;
			client.balance = async () => {
				// Another tick claims the slot while this one checks the balance.
				await db
					.prepare(
						"UPDATE claude_env_subscriptions SET iproyal_order_state = 'posting', iproyal_posting_at = 1",
					)
					.run();
				return original();
			};
			await run(t0 + 2000, client);
			expect(calls.create).toBe(0);
			expect(await events()).toEqual([]);
		});

		const summary = (
			id: string,
			extra: Partial<
				Awaited<ReturnType<IproyalClient["listOrders"]>>[number]
			> = {},
		) => ({
			id,
			status: "confirmed",
			ips: [`10.0.0.${id.length}`],
			expireDate: "2026-11-25 11:25:30",
			planName: "30 Days",
			location: "美国",
			autoExtend: false,
			note: null,
			extendedCount: 0,
			...extra,
		});
		const cityFetcher = vi.fn(async () =>
			Response.json({
				status: "success",
				city: "Springfield",
				regionName: "Massachusetts",
			}),
		) as unknown as typeof fetch;
		const reconcile = (
			now: number,
			orders: ReturnType<typeof summary>[],
			send: (text: string) => Promise<void> = deliver,
		) =>
			reconcileIproyalOrders({
				db,
				now,
				iproyal: fakeIproyal({ listOrders: async () => orders }).client,
				fetcher: cityFetcher,
				deliver: send,
			});

		it("alerts once for an unknown order, even with the automation flag off", async () => {
			const unknown = summary("86560286", { ips: ["161.77.53.219"] });
			expect(await reconcile(t0, [unknown])).toMatchObject({
				status: "ok",
				unknown: 1,
				alerted: 1,
			});
			expect(messages).toHaveLength(1);
			expect(messages[0]).toContain("#86560286");
			expect(messages[0]).toContain(
				"161.77.53.219（Springfield, Massachusetts）",
			);
			expect(messages[0]).toContain("自动续费：关");
			expect(messages[0]).toContain("约 2026-10-26 19:25 下单（北京时间");
			expect(messages[0]).toContain("备注：无");
			// Within 10 minutes the step does not even call IPRoyal.
			expect(await reconcile(t0 + 5 * minute, [unknown])).toEqual({
				status: "skipped",
			});
			// Later runs still see it but never alert again.
			expect(await reconcile(t0 + 11 * minute, [unknown])).toMatchObject({
				unknown: 1,
				alerted: 0,
			});
			expect(await reconcile(t0 + 3 * dayMs, [unknown])).toMatchObject({
				alerted: 0,
			});
			expect(messages).toHaveLength(1);
		});

		it("knows the seeded manual orders, subscription orders, and ignores refunded ones", async () => {
			const { client } = fakeIproyal();
			await provision(client);
			const result = await reconcile(t0 + hour, [
				summary("75930342", { autoExtend: true }),
				summary("86547609", { autoExtend: true }),
				summary("4242"),
				summary("75923490", { status: "refunded" }),
				summary("75926964", { status: "expired" }),
			]);
			expect(result).toMatchObject({ orders: 5, unknown: 0, alerted: 0 });
			expect(messages.filter((m) => m.includes("不认识"))).toEqual([]);
			const admin = await loadAdmin(db, t0 + hour);
			expect(admin.iproyalOrders?.checkedAt).toBe(t0 + hour);
			expect(admin.iproyalOrders?.orders.map((o) => [o.id, o.known])).toEqual([
				["75930342", "老板自用 161.77.8.204"],
				["86547609", "客户 GM1E7EC2 161.77.217.39（手动 provision.py）"],
				["4242", `订阅 ${(await sub())?.id}`],
				["75923490", null],
				["75926964", null],
			]);
		});

		it("points at an unresolved purchase when one is pending", async () => {
			const { client } = fakeIproyal({
				createOrder: async () => {
					throw new IproyalError("iproyal_unreachable", null, false);
				},
			});
			await enable();
			await insertOrder({
				id: "o1",
				userId: "u1",
				sku: monthlySku,
				paidAt: t0 + 1000,
			});
			await run(t0 + 2000, client);
			messages = [];
			await reconcile(t0 + hour, [summary("999")]);
			expect(messages[0]).toContain("另有 1 个订阅下单结果不明");
		});

		it("retries an alert whose delivery failed", async () => {
			const failing = vi.fn(async () => {
				throw new Error("telegram down");
			});
			expect(await reconcile(t0, [summary("777")], failing)).toMatchObject({
				alerted: 0,
			});
			expect(await reconcile(t0 + 11 * minute, [summary("777")])).toMatchObject(
				{
					alerted: 1,
				},
			);
			expect(messages).toHaveLength(1);
		});

		it("does nothing without a token", async () => {
			expect(await reconcileIproyalOrders({ db, now: t0 })).toEqual({
				status: "no_token",
			});
		});
	});

	describe("renewal SKUs and traffic add-ons", () => {
		const traffic100 = "c3675807-27e7-4442-a820-e4016b8c0e37";
		const traffic500 = "f1ea0f36-274a-414c-aa36-c6ebad153d3b";
		const ebMonthlySku = "979f1ac1-5082-4758-bc3c-90b3230ee03f";
		const GB = 1_000_000_000;
		const opsToken = "ops-token-0123456789";

		/** The live catalog rows the panel prices come from, then the ops SQL. */
		async function seedCatalog() {
			const now = t0 - dayMs;
			await db.batch([
				db
					.prepare(
						"INSERT INTO products (id, name, product_type, status, created_at, updated_at) VALUES (?, 'Claude 稳定使用环境', 'stock', 'active', ?, ?)",
					)
					.bind(claudeEnvProductId, now, now),
				db
					.prepare(
						`INSERT INTO product_sellable_items (id, product_id, name, currency, currency_decimals, price_minor, sort_order, created_at, updated_at)
						 VALUES (?, ?, '月付', 'CNY', 2, '29900', 1, ?, ?), (?, ?, '季付', 'CNY', 2, '79900', 2, ?, ?)`,
					)
					.bind(
						monthlySku,
						claudeEnvProductId,
						now,
						now,
						quarterlySku,
						claudeEnvProductId,
						now,
						now,
					),
			]);
			const sql = await readFile(
				new URL("../../ops/claude-env-traffic-skus.sql", import.meta.url),
				"utf8",
			);
			for (const statement of sql
				.split(/;\s*\n/)
				.map((part) =>
					part
						.split("\n")
						.filter((line) => !line.trim().startsWith("--"))
						.join("\n")
						.trim(),
				)
				.filter(Boolean))
				await db.prepare(statement).run();
		}

		async function activeSubscription(client: IproyalClient) {
			await seedCatalog();
			const id = await provision(client);
			await run(t0 + 6 * minute, client);
			expect((await sub())?.status).toBe("active");
			return id;
		}

		const runT = (
			now: number,
			client: IproyalClient,
			sendTrafficEmail = vi.fn<SendTrafficEmail>(async () => ({
				status: "queued",
			})),
		) =>
			runClaudeEnv({
				db,
				now,
				iproyal: client,
				fetcher: qualityFetcher(98, 32),
				deliver,
				sendCustomerEmail: vi.fn(async () => undefined),
				sendTrafficEmail,
				sleep: async () => undefined,
			});

		const useTraffic = (id: string, bytes: number, now: number) =>
			report(`traffic-${crypto.randomUUID()}`, [], now, {
				traffic: [{ id, up_bytes: bytes, down_bytes: 0 }],
			});

		async function buyAddon(
			orderId: string,
			sku: string,
			paidAt: number,
			userId: string | null = "u1",
		) {
			await insertOrder({
				id: orderId,
				userId,
				sku,
				paidAt,
				status: "paid",
				productId: claudeEnvTrafficProductId,
			});
			await db
				.prepare(
					"INSERT INTO delivery_records (id, order_item_id, delivery_type, status, created_at, updated_at) VALUES (?, ?, 'stock', 'awaiting_supply', ?, ?)",
				)
				.bind(`${orderId}-delivery`, `${orderId}-item`, paidAt, paidAt)
				.run();
		}

		it("any renewal SKU extends any plan, early-bird included", async () => {
			const { client, calls } = fakeIproyal();
			await enable();
			await insertOrder({
				id: "o1",
				userId: "u1",
				sku: ebMonthlySku,
				paidAt: t0 + 1000,
			});
			await run(t0 + 2000, client);
			await report("rep-eb", [okResult((await sub())?.id)], t0 + 3 * minute);
			await run(t0 + 4 * minute, client);
			expect(await sub()).toMatchObject({
				plan: "eb_monthly",
				status: "active",
			});
			await insertOrder({
				id: "o2",
				userId: "u1",
				sku: quarterlySku,
				paidAt: t0 + 10 * minute,
			});
			await run(t0 + 11 * minute, client);
			expect(calls.extend).toEqual([["4242", 25]]);
			expect((await sub())?.expires_at).toBe(iproyalExpiry + 90 * dayMs);
		});

		it("panel offers live renewal and traffic prices that go straight to checkout", async () => {
			const { client } = fakeIproyal();
			await activeSubscription(client);
			await db
				.prepare(
					"UPDATE product_sellable_items SET price_minor = '28800' WHERE id = ?",
				)
				.bind(monthlySku)
				.run();
			const panel = await loadClaudeEnvPanel(db, "u1", "GMO1", t0 + hour);
			expect(panel).toMatchObject({
				renewOptions: [
					{
						period: "monthly",
						sku: monthlySku,
						priceMinor: "28800",
						currency: "CNY",
						href: `/checkout?mode=buy-now&sellableItemId=${monthlySku}&quantity=1`,
					},
					{ period: "quarterly", sku: quarterlySku, priceMinor: "79900" },
				],
				trafficOptions: [
					{ label: "100GB", gb: 100, priceMinor: "3000" },
					{ label: "500GB", gb: 500, priceMinor: "12900" },
					{ label: "1TB", gb: 1000, priceMinor: "22900" },
				],
				trafficQuotaBytes: 200 * GB,
				trafficLevel: null,
			});
			// A SKU taken off sale disappears from the choice.
			await db
				.prepare(
					"UPDATE product_sellable_items SET sale_disabled = 1 WHERE id = ?",
				)
				.bind(traffic500)
				.run();
			const after = await loadClaudeEnvPanel(db, "u1", "GMO1", t0 + hour);
			expect(after?.state === "subscription" && after.trafficOptions).toEqual([
				expect.objectContaining({ label: "100GB" }),
				expect.objectContaining({ label: "1TB" }),
			]);
		});

		it("applies an add-on to the current period at once, completes the order and alerts the owner", async () => {
			const { client } = fakeIproyal();
			const id = await activeSubscription(client);
			await useTraffic(id, 120 * GB, t0 + hour);
			await buyAddon("a1", traffic100, t0 + 2 * hour);
			// The buyer opens the add-on order page before the cron runs.
			expect(
				await ingestTrafficForOrder(db, "u1", "GMA1", t0 + 2 * hour, deliver),
			).toBe(1);
			const panel = await loadClaudeEnvPanel(db, "u1", "GMA1", t0 + 2 * hour);
			expect(panel).toMatchObject({
				state: "subscription",
				trafficUsedBytes: 120 * GB,
				trafficQuotaBytes: 300 * GB,
				trafficBaseBytes: 200 * GB,
				trafficAddonBytes: 100 * GB,
			});
			expect(JSON.stringify(panel)).not.toMatch(/iproyal|4242/i);
			const alert = messages.find((m) => m.includes("加流量（已付款"));
			expect(alert).toContain("GMA1");
			expect(alert).toContain("bu****@example.com");
			expect(alert).toContain("100GB");
			expect(alert).toContain("#4242");
			const delivery = await db
				.prepare("SELECT status FROM delivery_records WHERE id = 'a1-delivery'")
				.first<Row>();
			expect(delivery?.status).toBe("delivered");
			expect(
				(
					await db
						.prepare("SELECT status FROM shop_orders WHERE id = 'a1'")
						.first<Row>()
				)?.status,
			).toBe("completed");
			// The cron sees it as done: no second application.
			await runT(t0 + 2 * hour + minute, client);
			const rows = await db
				.prepare("SELECT * FROM claude_env_traffic_addons")
				.all<Row>();
			expect(rows.results).toHaveLength(1);
			expect(rows.results[0]).toMatchObject({
				status: "applied",
				delivered: 1,
				bytes: 100 * GB,
			});
			// Next 30-day period: back to the base 200 GB.
			const nextPeriod = t0 + 6 * minute + 30 * dayMs + hour;
			await useTraffic(id, GB, nextPeriod);
			expect(
				await loadClaudeEnvPanel(db, "u1", "GMO1", nextPeriod),
			).toMatchObject({
				trafficUsedBytes: GB,
				trafficQuotaBytes: 200 * GB,
				trafficAddonBytes: 0,
			});
		});

		it("parks guest add-ons, skips buyers without an active environment and takes refunds back", async () => {
			const { client } = fakeIproyal();
			await activeSubscription(client);
			await buyAddon("g1", traffic100, t0 + hour, null);
			await db
				.prepare(
					"UPDATE shop_orders SET normalized_contact_email = 'guest@example.com' WHERE id = 'g1'",
				)
				.run();
			await buyAddon("n1", traffic100, t0 + hour, "u2");
			await runT(t0 + hour + minute, client);
			const status = async (orderId: string) =>
				(
					await db
						.prepare(
							"SELECT status, note FROM claude_env_traffic_addons WHERE order_id = ?",
						)
						.bind(orderId)
						.first<Row>()
				)?.status;
			expect(await status("g1")).toBe("waiting");
			expect(await status("n1")).toBe("skipped");
			expect(messages.some((m) => m.includes("游客订单 GMG1"))).toBe(true);
			expect(
				messages.some(
					(m) => m.includes("GMN1") && m.includes("没有正在使用的专属环境"),
				),
			).toBe(true);

			await buyAddon("r1", traffic100, t0 + 2 * hour);
			await runT(t0 + 2 * hour + minute, client);
			expect(
				await loadClaudeEnvPanel(db, "u1", "GMO1", t0 + 3 * hour),
			).toMatchObject({ trafficQuotaBytes: 300 * GB });
			await db
				.prepare("UPDATE shop_orders SET status = 'refunded' WHERE id = 'r1'")
				.run();
			await runT(t0 + 3 * hour, client);
			expect(await status("r1")).toBe("refunded");
			expect(
				await loadClaudeEnvPanel(db, "u1", "GMO1", t0 + 3 * hour),
			).toMatchObject({ trafficQuotaBytes: 200 * GB });
			expect(messages.some((m) => m.includes("GMR1 已退款"))).toBe(true);
		});

		it("emails 75 / 90 / 97.5% once per period and re-arms only on a new crossing after an add-on", async () => {
			const { client } = fakeIproyal();
			const id = await activeSubscription(client);
			const email = vi.fn<SendTrafficEmail>(async () => ({ status: "queued" }));
			const thresholds = () => email.mock.calls.map((c) => c[1].threshold);

			await useTraffic(id, 150 * GB, t0 + hour);
			await runT(t0 + hour + minute, client, email);
			await runT(t0 + hour + 2 * minute, client, email);
			expect(thresholds()).toEqual([7500]);
			expect(email.mock.calls[0]?.[1]).toMatchObject({
				to: "buyer1@example.com",
				orderNumber: "GMO1",
				usedBytes: 150 * GB,
				entitledBytes: 200 * GB,
				locale: "zh-CN",
			});
			expect(
				await loadClaudeEnvPanel(db, "u1", "GMO1", t0 + hour + 2 * minute),
			).toMatchObject({ trafficLevel: 7500 });

			// A jump across 90% and 97.5% sends only the highest.
			await useTraffic(id, 46 * GB, t0 + 2 * hour);
			await runT(t0 + 2 * hour + minute, client, email);
			expect(thresholds()).toEqual([7500, 9750]);

			// +500 GB: 196 / 700 GB is below every threshold again.
			await buyAddon("a5", traffic500, t0 + 3 * hour);
			await runT(t0 + 3 * hour + minute, client, email);
			expect(thresholds()).toEqual([7500, 9750]);
			// A real new crossing of 75% of 700 GB = 525 GB.
			await useTraffic(id, 330 * GB, t0 + 4 * hour);
			await runT(t0 + 4 * hour + minute, client, email);
			expect(thresholds()).toEqual([7500, 9750, 7500]);
			expect(email.mock.calls[2]?.[1]).toMatchObject({
				usedBytes: 526 * GB,
				entitledBytes: 700 * GB,
			});
		});

		it("an add-on that leaves usage above a threshold does not resend it", async () => {
			const { client } = fakeIproyal();
			const id = await activeSubscription(client);
			const email = vi.fn<SendTrafficEmail>(async () => ({ status: "queued" }));
			await useTraffic(id, 260 * GB, t0 + hour);
			await runT(t0 + hour + minute, client, email);
			expect(email).toHaveBeenCalledTimes(1);
			// 260 / 300 GB is still above 75% (and below 90%): nothing new.
			await buyAddon("a1", traffic100, t0 + 2 * hour);
			await runT(t0 + 2 * hour + minute, client, email);
			await runT(t0 + 2 * hour + 2 * minute, client, email);
			expect(email).toHaveBeenCalledTimes(1);
		});

		it("real sender: renders the notice through the approved channel only", async () => {
			const html = renderClaudeEnvTrafficEmail({
				locale: "zh-CN",
				threshold: 9000,
				usedBytes: 180 * GB,
				entitledBytes: 200 * GB,
				periodEnd: t0 + 30 * dayMs,
				addTrafficUrl:
					"https://laoshirenvip.com/account/orders/GMO1#claude-env-traffic",
			});
			expect(html.subject).toContain("90%");
			expect(html.text).toContain("已用 180 GB / 本期共 200 GB，剩余 20 GB");
			expect(html.text).toContain("#claude-env-traffic");
			expect(`${html.text}${html.html}`).not.toMatch(
				/IPRoyal|住宅|梯子|VPN|翻墙/i,
			);
			const en = renderClaudeEnvTrafficEmail({
				locale: "en-US",
				threshold: 9750,
				usedBytes: 195 * GB,
				entitledBytes: 200 * GB,
				periodEnd: t0 + 30 * dayMs,
				addTrafficUrl: "https://laoshirenvip.com/x",
			});
			expect(en.subject).toContain("97.5%");
			expect(
				await enqueueClaudeEnvTrafficEmail(db, {
					subscriptionId: "s",
					to: "buyer1@example.com",
					orderNumber: "GMO1",
					threshold: 7500,
					periodStart: t0,
					periodEnd: t0 + 30 * dayMs,
					usedBytes: 150 * GB,
					entitledBytes: 200 * GB,
					locale: "zh-CN",
				}),
			).toEqual({ status: "skipped", reason: "sender_unavailable" });
		});

		it("owner safety net: one alert per period at 85 GB without a reported purchase", async () => {
			const { client } = fakeIproyal();
			const id = await activeSubscription(client);
			await useTraffic(id, 84 * GB, t0 + hour);
			await runT(t0 + hour + minute, client);
			expect(messages.some((m) => m.includes("自动采购还没回报"))).toBe(false);
			await useTraffic(id, 2 * GB, t0 + 2 * hour);
			await runT(t0 + 2 * hour + minute, client);
			await runT(t0 + 2 * hour + 2 * minute, client);
			const alerts = messages.filter((m) => m.includes("自动采购还没回报"));
			expect(alerts).toHaveLength(1);
			expect(alerts[0]).toContain("已用 86 GB，IPRoyal 订单 #4242 需要加流量");

			// Next period: a purchase reported before 85 GB keeps it quiet.
			const next = t0 + 6 * minute + 30 * dayMs + hour;
			const env = { DB: db, RESTOCK_API_TOKEN: opsToken } as never;
			const post = await handleClaudeEnvTrafficOps(
				new Request(
					"https://laoshirenvip.com/api/ops/claude-env/traffic/purchases",
					{
						method: "POST",
						headers: { Authorization: `Bearer ${opsToken}` },
						body: JSON.stringify({
							purchases: [
								{
									iproyalOrderId: "4242",
									gb: 100,
									costUsd: 12.5,
									ref: "buy-next",
									at: next,
								},
							],
						}),
					},
				),
				env,
				"purchases",
				{ now: next, deliver },
			);
			expect(post.status).toBe(200);
			await useTraffic(id, 90 * GB, next + minute);
			await runT(next + 2 * minute, client);
			expect(
				messages.filter((m) => m.includes("自动采购还没回报")),
			).toHaveLength(1);
		});

		it("ops traffic API: bearer auth, current-period numbers, idempotent purchases and usage readings", async () => {
			const { client } = fakeIproyal();
			const id = await activeSubscription(client);
			const env = { DB: db, RESTOCK_API_TOKEN: opsToken } as never;
			const call = async (
				route: "list" | "purchases",
				init: RequestInit & { token?: string | null } = {},
				now = t0 + 3 * hour,
			) => {
				const { token = opsToken, ...rest } = init;
				const response = await handleClaudeEnvTrafficOps(
					new Request(
						`https://laoshirenvip.com/api/ops/claude-env/traffic${route === "purchases" ? "/purchases" : ""}`,
						{
							...rest,
							headers: token ? { Authorization: `Bearer ${token}` } : {},
						},
					),
					env,
					route,
					{ now, deliver },
				);
				return {
					status: response.status,
					// biome-ignore lint/suspicious/noExplicitAny: response JSON in assertions
					json: (await response.json()) as any,
				};
			};
			expect((await call("list", { token: null })).status).toBe(401);
			expect((await call("list", { token: "wrong" })).status).toBe(401);
			expect((await call("list", { method: "POST" })).status).toBe(405);

			await useTraffic(id, 90 * GB, t0 + hour);
			await buyAddon("a1", traffic100, t0 + 2 * hour);
			await runT(t0 + 2 * hour + minute, client);
			const activatedAt = (await sub())?.activated_at as number;
			const list = await call("list");
			expect(list).toEqual({
				status: 200,
				json: {
					ok: true,
					generatedAt: new Date(t0 + 3 * hour).toISOString(),
					includedBytesPerCycle: 100 * GB,
					subscriptions: [
						{
							subscriptionId: id,
							iproyalOrderId: "4242",
							ip: "161.77.8.204",
							periodStart: new Date(activatedAt).toISOString(),
							periodEnd: new Date(activatedAt + 30 * dayMs).toISOString(),
							expiresAt: new Date(iproyalExpiry).toISOString(),
							entitledBytes: 300 * GB,
							relayUsedBytes: 90 * GB,
							upstreamPurchasedBytes: 0,
							upstreamCapacityBytes: 100 * GB,
							upstreamUsedBytes: null,
							upstreamUsedAt: null,
						},
					],
				},
			});

			const body = {
				purchases: [
					{
						iproyalOrderId: "4242",
						gb: 100,
						costUsd: 12.5,
						ref: "ipr-1",
						at: "2026-10-24T04:00:00Z",
					},
				],
				usage: [
					{ iproyalOrderId: "4242", usedBytes: 88 * GB, at: t0 + 3 * hour },
					{ iproyalOrderId: "999", usedBytes: 1, at: t0 + 3 * hour },
				],
			};
			const first = await call("purchases", {
				method: "POST",
				body: JSON.stringify(body),
			});
			expect(first).toEqual({
				status: 200,
				json: {
					ok: true,
					purchases: [{ ref: "ipr-1", status: "recorded", subscriptionId: id }],
					usage: [
						{ iproyalOrderId: "4242", status: "recorded" },
						{ iproyalOrderId: "999", status: "unknown_order" },
					],
				},
			});
			const again = await call("purchases", {
				method: "POST",
				body: JSON.stringify({
					...body,
					usage: [{ iproyalOrderId: "4242", usedBytes: 1, at: t0 }],
				}),
			});
			expect(again.json).toMatchObject({
				purchases: [{ ref: "ipr-1", status: "duplicate" }],
				usage: [{ iproyalOrderId: "4242", status: "stale" }],
			});
			expect(
				messages.filter((m) => m.includes("IPRoyal 加流量已回报")),
			).toHaveLength(1);
			const after = (await call("list")).json.subscriptions[0];
			expect(after).toMatchObject({
				upstreamPurchasedBytes: 100 * GB,
				upstreamCapacityBytes: 200 * GB,
				upstreamUsedBytes: 88 * GB,
				upstreamUsedAt: new Date(t0 + 3 * hour).toISOString(),
			});
			expect(
				(await call("purchases", { method: "POST", body: "{}" })).status,
			).toBe(400);
			expect(
				(await call("purchases", { method: "POST", body: "nope" })).status,
			).toBe(400);
			const admin = await loadAdmin(db, t0 + 3 * hour);
			expect(admin.subscriptions[0]?.traffic).toMatchObject({
				entitledBytes: 300 * GB,
				upstreamCapacityBytes: 200 * GB,
			});
			expect(admin.addons).toHaveLength(1);
			expect(admin.upstreamPurchases).toHaveLength(1);
		});

		it("keeps the add-on product off the sitemap", async () => {
			await seedCatalog();
			const products = await listIndexedProducts(db);
			expect(products.map((p) => p.id)).toContain(claudeEnvProductId);
			expect(products.map((p) => p.id)).not.toContain(
				claudeEnvTrafficProductId,
			);
		});
	});
});
