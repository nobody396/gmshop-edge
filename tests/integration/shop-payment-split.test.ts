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
	processShopRefund,
	requestShopRefund,
} from "#/features/shop-payments/server/refunds";
import {
	createShopPayment,
	createWalletTopupPayment,
	processShopPaymentEvent,
} from "#/features/shop-payments/server/service";
import {
	channelCollectedTodayMinor,
	checkoutChannelLimits,
	resumeSplitPayment,
	settleSplitPayments,
} from "#/features/shop-payments/server/split";
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
		if (method === "alipay.trade.refund")
			return this.sign(
				key,
				this.refundFailure
					? { code: "40004", sub_code: this.refundFailure }
					: {
							code: "10000",
							out_trade_no: business.out_trade_no,
							refund_fee: business.refund_amount,
						},
			);
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
		// Each part counts once towards the daily total; the parent does not.
		expect(await channelCollectedTodayMinor(db, channelId)).toBe(300000n);
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
			.bind(now - 86_400_000 - 1)
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
