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
import { expireStoreOrders } from "#/features/shop-orders/server/expiration";
import type { PaymentWebhookEvent } from "#/features/shop-payments/provider";
import {
	bytesToBase64,
	rsaSha256Sign,
} from "#/features/shop-payments/providers/rsa";
import {
	assertPriceSource,
	priceLinkStatements,
} from "#/features/shop-payments/server/price-link";
import {
	completeManualShopRefund,
	processShopRefund,
	requestShopRefund,
} from "#/features/shop-payments/server/refunds";
import {
	createShopPayment,
	createWalletTopupPayment,
	processShopPaymentEvent,
} from "#/features/shop-payments/server/service";
import {
	channelDailyUsageMinor,
	channelHasUnsettledSplitPayments,
	checkoutChannelLimits,
	completeSplitPaymentIfReady,
	completeSplitRefundsManually,
	ensureNextSplitPart,
	listManualSplitRefunds,
	resumeSplitPayment,
	runPartRefund,
	settleSplitPayments,
} from "#/features/shop-payments/server/split";
import { beijingDayStart } from "#/features/shop-payments/split";
import { upsertFeishuAlertSetting } from "#/features/telegram/server/feishu-alerts";
import {
	encryptTelegramOwnerAlertBotToken,
	telegramOwnerAlertSettingKeys,
} from "#/features/telegram/server/owner-alerts";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const orderId = "11111111-1111-4111-8111-111111111111";
const orderItemId = "22222222-2222-4222-8222-222222222222";
const channelId = "33333333-3333-4333-8333-333333333333";
const stripeChannelId = "55555555-5555-4555-8555-555555555555";
const secret = "commerce-test-secret";
const botToken = "1234567890:AAtest-only-owner-alert-token_abcdefgh";

type AlipayCall = {
	method: string;
	business: Record<string, string>;
	notifyUrl?: string;
};

/** A minimal signed Alipay gateway plus Telegram, recording every call. */
class AlipaySimulator {
	calls: AlipayCall[] = [];
	telegram: string[] = [];
	paid = new Map<string, string>();
	refundFailure: string | null = null;
	/** Per trade: "network" (HTTP 500), or an Alipay sub_code refusal. */
	refundFailures = new Map<string, string>();
	queryFailures = new Set<string>();
	refunded = new Map<string, bigint>();
	refundRequests = new Set<string>();
	/** Runs inside the refund call, before Alipay answers (concurrency tests). */
	onRefund: ((outTradeNo: string) => Promise<void>) | null = null;
	constructor(private readonly privateKeyPem: string) {}

	fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.startsWith("https://api.telegram.org/")) {
			const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
			this.telegram.push(body.text ?? "");
			return Response.json({ ok: true, result: { message_id: 1 } });
		}
		const parameters = Object.fromEntries(
			new URLSearchParams(String(init?.body)),
		);
		const business = JSON.parse(parameters.biz_content ?? "{}");
		const method = parameters.method ?? "";
		this.calls.push({ method, business, notifyUrl: parameters.notify_url });
		const key = `${method.replaceAll(".", "_")}_response`;
		if (method === "alipay.trade.precreate")
			return this.sign(key, {
				code: "10000",
				msg: "Success",
				out_trade_no: business.out_trade_no,
				qr_code: `https://qr.alipay.com/bax${business.out_trade_no}`,
			});
		if (method === "alipay.trade.query") {
			if (this.queryFailures.has(business.out_trade_no))
				return new Response("unavailable", { status: 500 });
			const amount = this.paid.get(business.out_trade_no);
			return this.sign(
				key,
				amount
					? {
							code: "10000",
							out_trade_no: business.out_trade_no,
							trade_status: "TRADE_SUCCESS",
							total_amount: amount,
						}
					: { code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST" },
			);
		}
		if (method === "alipay.trade.close")
			return this.sign(key, { code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST" });
		if (method === "alipay.trade.refund") {
			const trade = business.out_trade_no as string;
			if (this.onRefund) await this.onRefund(trade);
			const failure = this.refundFailures.get(trade) ?? this.refundFailure;
			if (failure === "network")
				return new Response("unavailable", { status: 500 });
			if (failure) return this.sign(key, { code: "40004", sub_code: failure });
			// Alipay answers with the trade's cumulative refunded amount; the same
			// out_request_no is refunded only once.
			const requestKey = `${trade}:${business.out_request_no}`;
			if (!this.refundRequests.has(requestKey)) {
				this.refundRequests.add(requestKey);
				this.refunded.set(
					trade,
					(this.refunded.get(trade) ?? 0n) +
						BigInt(Math.round(Number(business.refund_amount) * 100)),
				);
			}
			const total = this.refunded.get(trade) ?? 0n;
			return this.sign(key, {
				code: "10000",
				out_trade_no: trade,
				refund_fee: (Number(total) / 100).toFixed(2),
			});
		}
		return new Response("unexpected", { status: 500 });
	});

	calledWith(method: string) {
		return this.calls.filter((call) => call.method === method);
	}

	private async sign(key: string, node: Record<string, unknown>) {
		const text = JSON.stringify(node);
		const sign = await rsaSha256Sign(this.privateKeyPem, text);
		return new Response(`{"${key}":${text},"sign":${JSON.stringify(sign)}}`);
	}
}

describe("Alipay QR split payments", { timeout: 60_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let merchant: { privateKeyPem: string; publicKeyPem: string };
	let alipay: { privateKeyPem: string; publicKeyPem: string };
	let simulator: AlipaySimulator;

	beforeAll(async () => {
		merchant = await rsaPair();
		alipay = await rsaPair();
	});

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db, merchant.privateKeyPem, alipay.publicKeyPem);
		simulator = new AlipaySimulator(alipay.privateKeyPem);
		// Webhook-driven steps (next part QR) use the global fetch.
		vi.stubGlobal("fetch", simulator.fetch);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await miniflare.dispose();
	});

	afterAll(() => vi.restoreAllMocks());

	async function startPayment(key = "split-checkout") {
		return createShopPayment(
			db,
			{
				orderId,
				channelId,
				idempotencyKey: key,
				successUrl: "https://shop.example/orders/GM100001",
				cancelUrl: "https://shop.example/orders/GM100001",
				payerIp: "203.0.113.10",
			},
			simulator.fetch as unknown as typeof fetch,
		);
	}

	async function parts() {
		return (
			await db
				.prepare(
					`SELECT id, part_index, amount_minor, status, provider_payment_id,
					 checkout_url, refunded_minor FROM payment_split_parts ORDER BY part_index`,
				)
				.all<{
					id: string;
					part_index: number;
					amount_minor: string;
					status: string;
					provider_payment_id: string | null;
					checkout_url: string | null;
					refunded_minor: string;
				}>()
		).results;
	}

	function paidEvent(
		outTradeNo: string,
		amountMinor: string,
		notifyId: string,
	): PaymentWebhookEvent {
		return {
			providerEventId: `alipay:${notifyId}`,
			providerPaymentId: outTradeNo,
			type: "payment_succeeded",
			amountMinor,
			currency: "CNY",
			merchantOrderId: outTradeNo,
			payloadDigest: `digest-${notifyId}`,
		};
	}

	async function order() {
		return db
			.prepare(
				"SELECT status, paid_minor, expires_at, version FROM shop_orders WHERE id=?",
			)
			.bind(orderId)
			.first<{
				status: string;
				paid_minor: string;
				expires_at: number;
				version: number;
			}>();
	}

	async function parent() {
		return db
			.prepare(
				`SELECT id, status, amount_minor, split_part_count, processing_fee_minor,
				 provider_payment_id, checkout_url, failure_code FROM payment_attempts
				 WHERE channel_id=? ORDER BY created_at DESC LIMIT 1`,
			)
			.bind(channelId)
			.first<{
				id: string;
				status: string;
				amount_minor: string;
				split_part_count: number | null;
				processing_fee_minor: string | null;
				provider_payment_id: string;
				checkout_url: string | null;
				failure_code: string | null;
			}>();
	}

	async function count(sql: string) {
		return Number(
			(await db.prepare(sql).first<{ count: number }>())?.count ?? 0,
		);
	}

	it("pays ¥3000 in two ¥1500 parts and fulfils only after both", async () => {
		const before = await order();
		const created = await startPayment();
		expect(created).toMatchObject({ status: "pending" });
		expect(created.checkoutUrl).toMatch(/^https:\/\/qr\.alipay\.com\/bax/);
		let rows = await parts();
		expect(rows.map((row) => [row.amount_minor, row.status])).toEqual([
			["150000", "pending"],
			["150000", "created"],
		]);
		expect(simulator.calledWith("alipay.trade.precreate")).toHaveLength(1);
		expect(simulator.calls[0]?.business.total_amount).toBe("1500");
		expect(simulator.calls[0]?.notifyUrl).toBe(
			`https://shop.example/api/shop/payments/${channelId}/webhook`,
		);
		expect(await parent()).toMatchObject({
			status: "pending",
			amount_minor: "300000",
			split_part_count: 2,
			// 0.6% of each ¥1500 part.
			processing_fee_minor: "1800",
			provider_payment_id: expect.stringMatching(/^split:/),
			checkout_url: created.checkoutUrl,
		});
		// Split orders get 15 minutes per part.
		expect((await order())?.expires_at).toBeGreaterThan(
			(before?.expires_at ?? 0) + 10 * 60_000,
		);
		// Idempotent checkout replay does not create another trade.
		await startPayment();
		expect(simulator.calledWith("alipay.trade.precreate")).toHaveLength(1);

		const first = rows[0]?.provider_payment_id as string;
		await expect(
			processShopPaymentEvent(db, channelId, paidEvent(first, "150000", "n1")),
		).resolves.toEqual({ duplicate: false, status: "split_part_succeeded" });
		expect((await order())?.status).toBe("pending_payment");
		rows = await parts();
		expect(rows.map((row) => row.status)).toEqual(["succeeded", "pending"]);
		expect(simulator.calledWith("alipay.trade.precreate")).toHaveLength(2);
		expect((await parent())?.checkout_url).toBe(rows[1]?.checkout_url);
		// Same notification again, and the same payment through reconciliation.
		await expect(
			processShopPaymentEvent(db, channelId, paidEvent(first, "150000", "n1")),
		).resolves.toMatchObject({ duplicate: true });
		simulator.paid.set(first, "1500.00");
		await resumeSplitPayment(
			db,
			orderId,
			simulator.fetch as unknown as typeof fetch,
			Date.now() + 5_000,
		);
		expect((await order())?.status).toBe("pending_payment");
		expect(simulator.calledWith("alipay.trade.precreate")).toHaveLength(2);
		// A part paid with the wrong amount is refused.
		const second = rows[1]?.provider_payment_id as string;
		await expect(
			processShopPaymentEvent(
				db,
				channelId,
				paidEvent(second, "149999", "bad"),
			),
		).rejects.toMatchObject({ code: "payment_amount_mismatch" });

		await expect(
			processShopPaymentEvent(db, channelId, paidEvent(second, "150000", "n2")),
		).resolves.toEqual({ duplicate: false, status: "succeeded" });
		expect(await order()).toMatchObject({
			status: "paid",
			paid_minor: "300000",
		});
		expect((await parent())?.status).toBe("succeeded");
		expect(
			await count(
				"SELECT COUNT(*) AS count FROM outbox_events WHERE event_type='shop_order.paid'",
			),
		).toBe(1);
		expect(await count("SELECT COUNT(*) AS count FROM delivery_records")).toBe(
			1,
		);
		expect(
			await count(
				"SELECT COUNT(*) AS count FROM payment_attempts WHERE status='succeeded'",
			),
		).toBe(1);
		// Late duplicate of the last part changes nothing.
		await expect(
			processShopPaymentEvent(db, channelId, paidEvent(second, "150000", "n2")),
		).resolves.toMatchObject({ duplicate: true });
		expect(await count("SELECT COUNT(*) AS count FROM delivery_records")).toBe(
			1,
		);
		// The plan's reservation counts once towards today's limit.
		expect(await channelDailyUsageMinor(db, channelId)).toBe(300000n);
	});

	it("refunds the paid part when a split order expires and alerts the owner", async () => {
		await configureTelegram(db);
		await startPayment();
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		const now = Date.now();
		await db
			.prepare("UPDATE shop_orders SET expires_at=? WHERE id=?")
			.bind(now - 1, orderId)
			.run();
		await expireStoreOrders(db, now);
		expect((await order())?.status).toBe("expired");
		expect((await parts()).map((row) => row.status)).toEqual([
			"succeeded",
			"expired",
		]);
		const settled = await settleSplitPayments(
			db,
			simulator.fetch as unknown as typeof fetch,
			now + 60_000,
		);
		expect(settled).toMatchObject({ refunded: 1, refundFailed: 0, alerts: 1 });
		const refunds = simulator.calledWith("alipay.trade.refund");
		expect(refunds).toHaveLength(1);
		expect(refunds[0]?.business).toMatchObject({
			out_trade_no: first?.provider_payment_id,
			refund_amount: "1500",
		});
		const rows = await parts();
		expect(rows.map((row) => [row.status, row.refunded_minor])).toEqual([
			["succeeded", "150000"],
			["closed", "0"],
		]);
		expect(simulator.telegram).toHaveLength(1);
		expect(simulator.telegram[0]).toContain("已自动退款");
		expect(simulator.telegram[0]).toContain("GM100001");
		expect(await count("SELECT COUNT(*) AS count FROM delivery_records")).toBe(
			0,
		);
		// Running again neither refunds nor alerts twice.
		await settleSplitPayments(
			db,
			simulator.fetch as unknown as typeof fetch,
			now + 120_000,
		);
		expect(simulator.calledWith("alipay.trade.refund")).toHaveLength(1);
		expect(simulator.telegram).toHaveLength(1);
	});

	it("sends a late part payment to review, never to fulfilment, and refunds it", async () => {
		await startPayment();
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		const second = (await parts())[1];
		const now = Date.now();
		await db
			.prepare("UPDATE shop_orders SET expires_at=? WHERE id=?")
			.bind(now - 1, orderId)
			.run();
		await expireStoreOrders(db, now);
		await expect(
			processShopPaymentEvent(
				db,
				channelId,
				paidEvent(second?.provider_payment_id as string, "150000", "late"),
			),
		).resolves.toEqual({
			duplicate: false,
			status: "reconciliation_required",
		});
		expect((await order())?.status).toBe("expired");
		expect(await parent()).toMatchObject({
			status: "expired",
			failure_code: "split_late_payment",
		});
		expect(
			await count(
				"SELECT COUNT(*) AS count FROM replay_receipts WHERE status='rejected'",
			),
		).toBe(1);
		await settleSplitPayments(
			db,
			simulator.fetch as unknown as typeof fetch,
			now + 60_000,
		);
		expect(
			simulator
				.calledWith("alipay.trade.refund")
				.map((call) => call.business.out_trade_no)
				.sort(),
		).toEqual([first?.provider_payment_id, second?.provider_payment_id].sort());
		expect(await count("SELECT COUNT(*) AS count FROM delivery_records")).toBe(
			0,
		);
	});

	it("leaves a refused refund for manual handling and alerts the owner", async () => {
		await configureTelegram(db);
		simulator.refundFailure = "ACQ.SELLER_BALANCE_NOT_ENOUGH";
		await startPayment();
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		const now = Date.now();
		await db
			.prepare("UPDATE shop_orders SET expires_at=? WHERE id=?")
			.bind(now - 1, orderId)
			.run();
		await expireStoreOrders(db, now);
		const settled = await settleSplitPayments(
			db,
			simulator.fetch as unknown as typeof fetch,
			now + 60_000,
		);
		expect(settled).toMatchObject({ refunded: 0, refundFailed: 1 });
		const refund = await db
			.prepare("SELECT status, failure_code FROM payment_split_refunds")
			.first();
		expect(refund).toEqual({
			status: "manual",
			failure_code: "ACQ.SELLER_BALANCE_NOT_ENOUGH",
		});
		expect(simulator.telegram[0]).toContain("需人工处理");
		await settleSplitPayments(
			db,
			simulator.fetch as unknown as typeof fetch,
			now + 600_000,
		);
		expect(simulator.calledWith("alipay.trade.refund")).toHaveLength(1);
		expect((await parts())[0]?.refunded_minor).toBe("0");
	});

	it("hides the channel when today's total plus the order exceeds the daily limit", async () => {
		const now = Date.now();
		await db
			.prepare(
				`INSERT INTO payment_attempts
				 (id, order_id, channel_id, provider_payment_id, idempotency_key, status,
				  amount_minor, currency, succeeded_at, created_at, updated_at)
				 VALUES ('earlier-payment', ?, ?, 'earlier', 'earlier', 'succeeded',
				  '1800000', 'CNY', ?, ?, ?)`,
			)
			.bind(orderId, channelId, now, now, now)
			.run();
		const limits = await checkoutChannelLimits(db, [
			{
				id: channelId,
				provider: "alipay_qr",
				split_enabled: 1,
				per_payment_max_minor: "200000",
				daily_max_minor: "2000000",
				split_max_parts: 10,
			},
			{ id: stripeChannelId, provider: "stripe" },
		]);
		expect(limits.get(channelId)?.dailyRemainingMinor).toBe("200000");
		// Other channels have no limits and stay available.
		expect(limits.has(stripeChannelId)).toBe(false);
		await expect(startPayment("over-daily")).rejects.toMatchObject({
			code: "payment_channel_limit_exceeded",
		});
		expect(simulator.calledWith("alipay.trade.precreate")).toHaveLength(0);
		// Yesterday (Beijing) does not count.
		await db
			.prepare(
				"UPDATE payment_attempts SET succeeded_at=? WHERE id='earlier-payment'",
			)
			.bind(beijingDayStart(now) - 1)
			.run();
		await expect(startPayment("next-day")).resolves.toMatchObject({
			status: "pending",
		});
	});

	it("keeps wallet top-ups within the limits without splitting", async () => {
		await db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('commerce.default_currency', '"CNY"', 0, 1, 1)`,
			)
			.run();
		await expect(
			createWalletTopupPayment(
				db,
				{
					userId: "customer-1",
					amountMinor: "300000",
					channelId,
					idempotencyKey: "topup-too-large",
					successUrl: "https://shop.example/wallet",
					cancelUrl: "https://shop.example/wallet",
				},
				simulator.fetch as unknown as typeof fetch,
			),
		).rejects.toMatchObject({ code: "payment_channel_limit_exceeded" });
		await expect(
			createWalletTopupPayment(
				db,
				{
					userId: "customer-1",
					amountMinor: "100000",
					channelId,
					idempotencyKey: "topup-ok",
					successUrl: "https://shop.example/wallet",
					cancelUrl: "https://shop.example/wallet",
				},
				simulator.fetch as unknown as typeof fetch,
			),
		).resolves.toMatchObject({ status: "pending" });
		expect(simulator.calledWith("alipay.trade.precreate")).toHaveLength(1);
	});

	it("refunds a paid split order part by part from the admin refund", async () => {
		await startPayment();
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		const second = (await parts())[1];
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(second?.provider_payment_id as string, "150000", "n2"),
		);
		expect((await order())?.status).toBe("paid");
		const refund = await requestShopRefund(
			db,
			{
				orderId,
				amountMinor: "200000",
				reason: "Customer request",
				idempotencyKey: "split-admin-refund",
			},
			{
				actorUserId: "customer-1",
				request: new Request("https://shop.example/admin"),
			},
		);
		await processShopRefund(
			db,
			refund.id,
			simulator.fetch as unknown as typeof fetch,
		);
		const calls = simulator.calledWith("alipay.trade.refund");
		expect(
			calls.map((call) => [
				call.business.out_trade_no,
				call.business.refund_amount,
			]),
		).toEqual([
			[second?.provider_payment_id, "1500"],
			[first?.provider_payment_id, "500"],
		]);
		expect((await parts()).map((row) => row.refunded_minor)).toEqual([
			"50000",
			"150000",
		]);
		expect(
			await db
				.prepare("SELECT status FROM refunds WHERE id=?")
				.bind(refund.id)
				.first(),
		).toEqual({ status: "succeeded" });
	});

	async function payBoth() {
		await startPayment();
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		const second = (await parts())[1];
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(second?.provider_payment_id as string, "150000", "n2"),
		);
		expect((await order())?.status).toBe("paid");
		return { first, second };
	}

	async function adminRefund(amountMinor: string, key: string) {
		return requestShopRefund(
			db,
			{ orderId, amountMinor, reason: "Customer request", idempotencyKey: key },
			{
				actorUserId: "customer-1",
				request: new Request("https://shop.example/admin"),
			},
		);
	}

	async function refundRow(id: string) {
		return db
			.prepare(
				"SELECT status, failure_code, next_attempt_at FROM refunds WHERE id=?",
			)
			.bind(id)
			.first<{
				status: string;
				failure_code: string | null;
				next_attempt_at: number | null;
			}>();
	}

	// #1: one part refunded, the other uncertain → never back to paid.
	it("keeps a partly refunded split order refunding and finishes with the same request ids", async () => {
		const { first, second } = await payBoth();
		simulator.refundFailures.set(
			first?.provider_payment_id as string,
			"network",
		);
		const refund = await adminRefund("300000", "split-partial-network");
		await processShopRefund(
			db,
			refund.id,
			simulator.fetch as unknown as typeof fetch,
		);
		expect((await order())?.status).toBe("refunding");
		expect((await refundRow(refund.id))?.status).toBe("processing");
		expect((await parts()).map((row) => row.refunded_minor)).toEqual([
			"0",
			"150000",
		]);
		// The network recovers; the next check refunds the rest exactly once.
		simulator.refundFailures.clear();
		await db
			.prepare("UPDATE refunds SET next_attempt_at=0 WHERE id=?; ")
			.bind(refund.id)
			.run();
		await db
			.prepare("UPDATE payment_split_refunds SET next_attempt_at=0")
			.run();
		await processShopRefund(
			db,
			refund.id,
			simulator.fetch as unknown as typeof fetch,
		);
		expect((await refundRow(refund.id))?.status).toBe("succeeded");
		expect((await order())?.status).toBe("refunded");
		expect((await parts()).map((row) => row.refunded_minor)).toEqual([
			"150000",
			"150000",
		]);
		expect(simulator.refunded.get(second?.provider_payment_id as string)).toBe(
			150000n,
		);
		expect(simulator.refunded.get(first?.provider_payment_id as string)).toBe(
			150000n,
		);
	});

	// #1 + #9: one part refunded, the other refused → manual, then closed by hand.
	it("sends a partly refused split refund to manual confirmation instead of restoring the order", async () => {
		const { first } = await payBoth();
		simulator.refundFailures.set(
			first?.provider_payment_id as string,
			"ACQ.SELLER_BALANCE_NOT_ENOUGH",
		);
		const refund = await adminRefund("300000", "split-partial-refused");
		await processShopRefund(
			db,
			refund.id,
			simulator.fetch as unknown as typeof fetch,
		);
		expect(await refundRow(refund.id)).toMatchObject({
			status: "processing",
			failure_code: "manual_action_required",
		});
		expect((await order())?.status).toBe("refunding");
		await completeManualShopRefund(db, refund.id, "ALIPAY-REFUND-1", true, {
			actorUserId: "customer-1",
			request: new Request("https://shop.example/admin"),
		});
		expect((await refundRow(refund.id))?.status).toBe("succeeded");
		expect((await order())?.status).toBe("refunded");
		expect((await parts()).map((row) => row.refunded_minor)).toEqual([
			"150000",
			"150000",
		]);
		expect(
			await db
				.prepare(
					"SELECT manual_reference FROM payment_split_refunds WHERE status='succeeded' AND manual_reference IS NOT NULL",
				)
				.first(),
		).toEqual({ manual_reference: "ALIPAY-REFUND-1" });
	});

	// #2: the deadline passed but the expiry job has not run yet.
	it("never completes a split order whose last part arrives after the deadline", async () => {
		await startPayment();
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		const second = (await parts())[1];
		await db
			.prepare("UPDATE shop_orders SET expires_at=? WHERE id=?")
			.bind(Date.now() - 5_000, orderId)
			.run();
		await expect(
			processShopPaymentEvent(
				db,
				channelId,
				paidEvent(second?.provider_payment_id as string, "150000", "n2"),
			),
		).resolves.toEqual({ duplicate: false, status: "reconciliation_required" });
		expect((await order())?.status).toBe("pending_payment");
		expect((await parent())?.status).toBe("pending");
		expect(await count("SELECT COUNT(*) AS count FROM delivery_records")).toBe(
			0,
		);
		// The guard is inside the order-paid batch: a completion attempted with a
		// clock past the deadline rolls back entirely.
		const expiresAt = (await order())?.expires_at ?? 0;
		await db
			.prepare("UPDATE shop_orders SET expires_at=? WHERE id=?")
			.bind(expiresAt + 600_000, orderId)
			.run();
		await expect(
			completeSplitPaymentIfReady(
				db,
				(await parent())?.id as string,
				expiresAt + 600_000,
			),
		).resolves.toBeNull();
		const parentRow = await parent();
		await expect(
			processShopPaymentEvent(
				db,
				channelId,
				{
					providerEventId: `split-complete:${parentRow?.id}`,
					providerPaymentId: parentRow?.provider_payment_id as string,
					type: "payment_succeeded",
					amountMinor: "300000",
					currency: "CNY",
					merchantOrderId: null,
					payloadDigest: `split-complete:${parentRow?.id}`,
				},
				{ requirePendingOrder: true, now: expiresAt + 600_001 },
			),
		).rejects.toThrow();
		expect((await order())?.status).toBe("pending_payment");
		expect(
			await count(
				"SELECT COUNT(*) AS count FROM replay_receipts WHERE external_id LIKE 'split-complete:%'",
			),
		).toBe(0);
		// Expiry and settlement refund both parts.
		const now = expiresAt + 600_002;
		await expireStoreOrders(db, now);
		await settleSplitPayments(
			db,
			simulator.fetch as unknown as typeof fetch,
			now + 60_000,
		);
		expect(simulator.calledWith("alipay.trade.refund")).toHaveLength(2);
	});

	// #3 (best-effort guard): open plans' unpaid remainder counts; later parts are not checked.
	it("counts open split plans against the daily limit and never re-checks later parts", async () => {
		await db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('commerce.default_currency', '"CNY"', 0, 1, 1)`,
			)
			.run();
		await db
			.prepare(
				"UPDATE payment_channels SET daily_max_minor='400000' WHERE id=?",
			)
			.bind(channelId)
			.run();
		await startPayment();
		const topup = (key: string) =>
			createWalletTopupPayment(
				db,
				{
					userId: "customer-1",
					amountMinor: "150000",
					channelId,
					idempotencyKey: key,
					successUrl: "https://shop.example/wallet",
					cancelUrl: "https://shop.example/wallet",
				},
				simulator.fetch as unknown as typeof fetch,
			);
		// Nothing is paid yet, but the open ¥3000 plan still needs ¥3000 today.
		expect(await channelDailyUsageMinor(db, channelId)).toBe(300000n);
		await expect(topup("topup-over-open-plan")).rejects.toMatchObject({
			code: "payment_channel_limit_exceeded",
		});
		const limits = await checkoutChannelLimits(db, [
			{
				id: channelId,
				provider: "alipay_qr",
				split_enabled: 1,
				per_payment_max_minor: "200000",
				daily_max_minor: "400000",
				split_max_parts: 10,
			},
		]);
		expect(limits.get(channelId)?.dailyRemainingMinor).toBe("100000");
		// Paid part + unpaid remainder: still ¥3000.
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		expect(await channelDailyUsageMinor(db, channelId)).toBe(300000n);
		// A lower limit set meanwhile does not stop the plan's next part.
		await db
			.prepare(
				"UPDATE payment_channels SET daily_max_minor='100000' WHERE id=?",
			)
			.bind(channelId)
			.run();
		expect((await parts())[1]?.status).toBe("pending");
		expect((await parts())[1]?.checkout_url).toMatch(
			/^https:\/\/qr\.alipay\.com/,
		);
		// Once the plan expires only the collected ¥1500 counts.
		const now = (await order())?.expires_at ?? 0;
		await expireStoreOrders(db, now + 1);
		expect(await channelDailyUsageMinor(db, channelId, now + 1)).toBe(150000n);
	});

	// The plan is frozen at the first part: a new single-payment limit does not change it.
	it("keeps an open plan's parts when the admin changes the single-payment limit", async () => {
		await startPayment();
		await db
			.prepare(
				"UPDATE payment_channels SET per_payment_max_minor='100000', fee_bps=0 WHERE id=?",
			)
			.bind(channelId)
			.run();
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		expect(
			(await parts()).map((row) => [row.amount_minor, row.status]),
		).toEqual([
			["150000", "succeeded"],
			["150000", "pending"],
		]);
		expect(await parent()).toMatchObject({
			split_part_count: 2,
			processing_fee_minor: "1800",
		});
		// A QR answer arriving late for a part already paid never reopens it.
		await db
			.prepare(
				"UPDATE payment_split_parts SET status='succeeded' WHERE part_index=2",
			)
			.run();
		await ensureNextSplitPart(
			db,
			(await parent())?.id as string,
			simulator.fetch as unknown as typeof fetch,
		);
		expect((await parts()).map((row) => row.status)).toEqual([
			"succeeded",
			"succeeded",
		]);
	});

	// #4: a signed answer must describe the requested trade and amount.
	it("does not treat a paid query without the amount or for another trade as payment", async () => {
		await startPayment();
		const [first] = await parts();
		const trade = first?.provider_payment_id as string;
		const realFetch = simulator.fetch.getMockImplementation();
		simulator.fetch.mockImplementation(async (input, init) => {
			const body = new URLSearchParams(String(init?.body));
			if (body.get("method") === "alipay.trade.query") {
				const node = JSON.stringify({
					code: "10000",
					out_trade_no: trade,
					trade_status: "TRADE_SUCCESS",
				});
				const sign = await rsaSha256Sign(alipay.privateKeyPem, node);
				return new Response(
					`{"alipay_trade_query_response":${node},"sign":${JSON.stringify(sign)}}`,
				);
			}
			return (realFetch as typeof fetch)(input, init);
		});
		await resumeSplitPayment(
			db,
			orderId,
			simulator.fetch as unknown as typeof fetch,
			Date.now() + 5_000,
		);
		expect((await parts())[0]?.status).toBe("pending");
		expect((await order())?.status).toBe("pending_payment");
	});

	// #4: a refund answer that does not match goes to manual handling.
	it("sends a refund answer for another amount to manual handling", async () => {
		await startPayment();
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		// Alipay reports more refunded on the trade than this request explains.
		simulator.refunded.set(first?.provider_payment_id as string, 100n);
		const now = Date.now();
		await db
			.prepare("UPDATE shop_orders SET expires_at=? WHERE id=?")
			.bind(now - 1, orderId)
			.run();
		await expireStoreOrders(db, now);
		await settleSplitPayments(
			db,
			simulator.fetch as unknown as typeof fetch,
			now + 60_000,
		);
		expect(
			await db
				.prepare("SELECT status, failure_code FROM payment_split_refunds")
				.first(),
		).toEqual({
			status: "manual",
			failure_code: "payment_refund_reconciliation_required",
		});
		expect((await parts())[0]?.refunded_minor).toBe("0");
	});

	// #5: every part pays its own fixed fee.
	it("charges enough that the split total covers every part's fee", async () => {
		await db.batch([
			db.prepare("DELETE FROM sellable_item_channel_prices"),
			db.prepare("UPDATE shop_orders SET pricing_channel_id=NULL"),
			db
				.prepare(
					"UPDATE payment_channels SET fee_bps=0, fixed_fee_minor='100' WHERE id=?",
				)
				.bind(channelId),
		]);
		await startPayment();
		const rows = await parts();
		const total = rows.reduce((sum, row) => sum + BigInt(row.amount_minor), 0n);
		expect(total).toBe(300200n);
		expect(rows.map((row) => row.amount_minor)).toEqual(["150100", "150100"]);
		expect((await parent())?.processing_fee_minor).toBe("200");
		expect(total - 200n).toBe(300000n);
	});

	// #6: a stale refund worker never overwrites a newer result.
	it("keeps a refund that another worker completed while this one was waiting", async () => {
		await startPayment();
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		await db
			.prepare(
				`INSERT INTO payment_split_refunds
				 (id, part_id, refund_id, amount_minor, reason, status, created_at, updated_at)
				 VALUES ('row-1', ?, NULL, '150000', 'order_not_paid_in_full', 'pending', 1, 1)`,
			)
			.bind(first?.id)
			.run();
		simulator.refundFailures.set(
			first?.provider_payment_id as string,
			"network",
		);
		simulator.onRefund = async () => {
			// Worker B took over after A's lease and refunded successfully.
			await db.batch([
				db.prepare(
					"UPDATE payment_split_refunds SET status='succeeded', attempt_count=attempt_count+1 WHERE id='row-1'",
				),
				db
					.prepare(
						"UPDATE payment_split_parts SET refunded_minor='150000' WHERE id=?",
					)
					.bind(first?.id),
			]);
		};
		await expect(
			runPartRefund(db, "row-1", 0, {
				fetcher: simulator.fetch as unknown as typeof fetch,
				now: Date.now(),
				reason: "test",
				maxAttempts: 3,
			}),
		).resolves.toBe("skipped");
		expect(
			await db
				.prepare("SELECT status FROM payment_split_refunds WHERE id='row-1'")
				.first(),
		).toEqual({ status: "succeeded" });
		expect((await parts())[0]?.refunded_minor).toBe("150000");
		// A row still leased to a worker is not claimed again.
		await db
			.prepare(
				"UPDATE payment_split_refunds SET status='failed', next_attempt_at=? WHERE id='row-1'",
			)
			.bind(Date.now() + 60_000)
			.run();
		simulator.onRefund = null;
		await expect(
			runPartRefund(db, "row-1", 1, {
				fetcher: simulator.fetch as unknown as typeof fetch,
				now: Date.now(),
				reason: "test",
				maxAttempts: 3,
			}),
		).resolves.toBe("skipped");
	});

	// #7: the payment product is frozen while split payments are open.
	it("reports open split payments that block changing the payment product", async () => {
		expect(await channelHasUnsettledSplitPayments(db, channelId)).toBe(false);
		await startPayment();
		// A plan is being paid: the channel's product must not change.
		expect(await channelHasUnsettledSplitPayments(db, channelId)).toBe(true);
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		expect(await channelHasUnsettledSplitPayments(db, channelId)).toBe(true);
		const second = (await parts())[1];
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(second?.provider_payment_id as string, "150000", "n2"),
		);
		// Fully paid and fulfilled: settled.
		expect(await channelHasUnsettledSplitPayments(db, channelId)).toBe(false);
	});

	// #8: a part whose query keeps failing backs off instead of blocking the scan.
	it("backs off parts whose provider query fails", async () => {
		await startPayment();
		const [first] = await parts();
		simulator.queryFailures.add(first?.provider_payment_id as string);
		const now = Date.now() + 60_000;
		await settleSplitPayments(
			db,
			simulator.fetch as unknown as typeof fetch,
			now,
		);
		const row = await db
			.prepare("SELECT next_check_at FROM payment_split_parts WHERE id=?")
			.bind(first?.id)
			.first<{ next_check_at: number | null }>();
		expect(row?.next_check_at).toBeGreaterThanOrEqual(now + 299_000);
		const queries = simulator.calledWith("alipay.trade.query").length;
		await settleSplitPayments(
			db,
			simulator.fetch as unknown as typeof fetch,
			now + 60_000,
		);
		expect(simulator.calledWith("alipay.trade.query")).toHaveLength(queries);
	});

	// #9: a refund Alipay refused is closed by hand with its refund number.
	it("closes a manual split refund with the Alipay refund number", async () => {
		simulator.refundFailure = "ACQ.SELLER_BALANCE_NOT_ENOUGH";
		await startPayment();
		const [first] = await parts();
		await processShopPaymentEvent(
			db,
			channelId,
			paidEvent(first?.provider_payment_id as string, "150000", "n1"),
		);
		const now = Date.now();
		await db
			.prepare("UPDATE shop_orders SET expires_at=? WHERE id=?")
			.bind(now - 1, orderId)
			.run();
		await expireStoreOrders(db, now);
		await settleSplitPayments(
			db,
			simulator.fetch as unknown as typeof fetch,
			now + 60_000,
		);
		const [manual] = await listManualSplitRefunds(db);
		expect(manual).toMatchObject({ orderNumber: "GM100001", partIndex: 1 });
		await expect(
			completeSplitRefundsManually(db, {
				rowIds: [manual?.id as string],
				reference: " ",
				actorUserId: "customer-1",
			}),
		).rejects.toMatchObject({ code: "refund_reference_invalid" });
		await expect(
			completeSplitRefundsManually(db, {
				rowIds: [manual?.id as string],
				reference: "2026111122001",
				actorUserId: "customer-1",
			}),
		).resolves.toEqual({ completed: 1 });
		await expect(
			completeSplitRefundsManually(db, {
				rowIds: [manual?.id as string],
				reference: "2026111122001",
				actorUserId: "customer-1",
			}),
		).resolves.toEqual({ completed: 0 });
		expect((await parts())[0]?.refunded_minor).toBe("150000");
		expect(await listManualSplitRefunds(db)).toEqual([]);
		expect(
			await db
				.prepare(
					"SELECT actor_user_id FROM audit_logs WHERE action='payment.split_refund_manually_completed'",
				)
				.all(),
		).toMatchObject({ results: [{ actor_user_id: "customer-1" }] });
	});

	// Pricing: the QR channel always charges the 支付宝 channel's prices.
	it("keeps a linked channel's prices equal to its source channel", async () => {
		const epayId = "66666666-6666-4666-8666-666666666666";
		await db.batch([
			db.prepare(
				`INSERT INTO payment_channels
				 (id, provider, name, currency, fee_bps, fixed_fee_minor, sort_order, enabled,
				  last_health_status, created_at, updated_at)
				 VALUES ('${epayId}', 'epay', '支付宝', 'CNY', 0, '0', 50, 1, 'healthy', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO sellable_item_channel_prices
				 (id, sellable_item_id, channel_id, price_minor, enabled, created_at, updated_at)
				 VALUES ('epay-price', 'sellableItem-card', '${epayId}', '288000', 1, 1, 1)`,
			),
		]);
		await assertPriceSource(db, channelId, epayId);
		await expect(
			assertPriceSource(db, channelId, channelId),
		).rejects.toMatchObject({ code: "payment_price_source_invalid" });
		const link = priceLinkStatements(db, {
			channelId,
			sourceId: epayId,
			now: 2,
		});
		await db.batch([
			...link.before,
			db
				.prepare(
					"UPDATE payment_channels SET price_source_channel_id=? WHERE id=?",
				)
				.bind(epayId, channelId),
			...link.after,
		]);
		const priceOf = async (channel: string) =>
			(
				await db
					.prepare(
						"SELECT price_minor, enabled FROM sellable_item_channel_prices WHERE channel_id=? AND sellable_item_id='sellableItem-card'",
					)
					.bind(channel)
					.first<{ price_minor: string; enabled: number }>()
			)?.price_minor ?? null;
		expect(await priceOf(channelId)).toBe("288000");
		// Pricing automation changes the 支付宝 price: the QR channel follows.
		await db
			.prepare(
				"UPDATE sellable_item_channel_prices SET price_minor='299000', updated_at=3 WHERE id='epay-price'",
			)
			.run();
		expect(await priceOf(channelId)).toBe("299000");
		// A different price on the linked channel is refused.
		await expect(
			db
				.prepare(
					"UPDATE sellable_item_channel_prices SET price_minor='1' WHERE channel_id=?",
				)
				.bind(channelId)
				.run(),
		).rejects.toThrow(/linked_channel_price_readonly/);
		// New and removed source prices are mirrored too.
		await db.batch([
			db.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, currency, currency_decimals, price_minor,
				  minimum_quantity, maximum_quantity, sort_order, enabled, created_at, updated_at)
				 VALUES ('sellableItem-2', 'product-card', 'Two', 'CNY', 2, '500000', 1, 1, 200, 1, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO sellable_item_channel_prices
				 (id, sellable_item_id, channel_id, price_minor, enabled, created_at, updated_at)
				 VALUES ('epay-price-2', 'sellableItem-2', '${epayId}', '480000', 1, 4, 4)`,
			),
		]);
		expect(
			await db
				.prepare(
					"SELECT price_minor FROM sellable_item_channel_prices WHERE channel_id=? AND sellable_item_id='sellableItem-2'",
				)
				.bind(channelId)
				.first(),
		).toEqual({ price_minor: "480000" });
		await db
			.prepare("DELETE FROM sellable_item_channel_prices WHERE id='epay-price'")
			.run();
		expect(await priceOf(channelId)).toBeNull();
	});
});

async function configureTelegram(db: D1Database) {
	await db.batch([
		upsertFeishuAlertSetting(
			db,
			telegramOwnerAlertSettingKeys.enabled,
			true,
			1,
		),
		upsertFeishuAlertSetting(
			db,
			telegramOwnerAlertSettingKeys.chatId,
			"-5101401750",
			1,
		),
		upsertFeishuAlertSetting(
			db,
			telegramOwnerAlertSettingKeys.botToken,
			await encryptTelegramOwnerAlertBotToken(db, botToken),
			1,
			true,
		),
	]);
}

async function seed(
	db: D1Database,
	merchantPrivateKeyPem: string,
	alipayPublicKeyPem: string,
) {
	const credential = await encryptSecret(
		JSON.stringify({
			appId: "2026000000000001",
			sellerId: "2088000000000001",
			privateKeyPem: merchantPrivateKeyPem,
			alipayPublicKeyPem,
		}),
		secret,
		"payment-credential",
	);
	const encryptedCard = await encryptSecret(
		"CARD-SECRET-1234",
		secret,
		"stock-entry",
	);
	const now = Date.now();
	await db.batch([
		db.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.data_encryption_secret', '"${secret}"', 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO products (id, name, product_type, status, sort_order, created_at, updated_at)
			 VALUES ('product-card', 'Card', 'stock', 'active', 100, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, currency, currency_decimals, price_minor,
			  minimum_quantity, maximum_quantity, sort_order, enabled, created_at, updated_at)
			 VALUES ('sellableItem-card', 'product-card', 'Default', 'CNY', 2, '300000',
			  1, 1, 100, 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
			 VALUES ('customer-1', 'Buyer', 'buyer@example.com', 1, 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, user_id, contact_email, normalized_contact_email,
				  status, currency, currency_decimals, subtotal_minor, discount_minor,
				  total_minor, paid_minor, version, expires_at, created_at, updated_at,
				  pricing_channel_id)
				 VALUES ('${orderId}', 'GM100001', 'customer-1', 'buyer@example.com',
				  'buyer@example.com', 'pending_payment', 'CNY', 2, '300000', '0',
				  '300000', '0', 1, ?, ?, ?, '${channelId}')`,
			)
			.bind(now + 15 * 60_000, now, now),
		db.prepare(
			`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
			  delivery_component_type, delivery_component_version, sellable_item_name,
			  quantity, unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
			 VALUES ('${orderItemId}', '${orderId}', 'product-card', 'sellableItem-card', 'Card',
			  'sellableItem-card', 'stock', 1, 'Default', 1, '300000', '0', '300000', 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO payment_channels
				 (id, provider, name, currency, credential_encrypted, credential_key_version,
				  fee_bps, fixed_fee_minor, sort_order, enabled, split_enabled,
				  per_payment_max_minor, daily_max_minor, split_max_parts,
				  last_health_status, created_at, updated_at)
				 VALUES ('${channelId}', 'alipay_qr', '支付宝', 'CNY', ?, 1, 60, '0', 100, 1, 1,
				  '200000', '2000000', 10, 'healthy', 1, 1)`,
			)
			.bind(credential),
		// Channel price: the order total already includes the 0.6% fee (no gross-up).
		db.prepare(
			`INSERT INTO sellable_item_channel_prices
			 (id, sellable_item_id, channel_id, price_minor, enabled, created_at, updated_at)
			 VALUES ('alipay-price', 'sellableItem-card', '${channelId}', '300000', 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO payment_channels
			 (id, provider, name, currency, fee_bps, fixed_fee_minor, sort_order, enabled,
			  last_health_status, created_at, updated_at)
			 VALUES ('${stripeChannelId}', 'stripe', 'Stripe', 'CNY', 0, '0', 200, 1,
			  'healthy', 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint,
				  content_mask, status, created_at, updated_at)
				 VALUES ('card-1', 'sellableItem-card', ?, 1, 'fingerprint-1', '••••1234',
				  'available', 1, 1)`,
			)
			.bind(encryptedCard),
	]);
}

async function rsaPair() {
	const pair = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const pem = (label: string, bytes: Uint8Array) =>
		`-----BEGIN ${label}-----\n${bytesToBase64(bytes)
			.match(/.{1,64}/g)
			?.join("\n")}\n-----END ${label}-----`;
	return {
		privateKeyPem: pem(
			"PRIVATE KEY",
			new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
		),
		publicKeyPem: pem(
			"PUBLIC KEY",
			new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
		),
	};
}
