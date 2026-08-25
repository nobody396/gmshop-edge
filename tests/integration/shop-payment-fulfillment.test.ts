import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import {
	completeManualDelivery,
	processDelivery,
} from "#/features/fulfillment/server/process";
import type { PaymentWebhookEvent } from "#/features/shop-payments/provider";
import {
	createShopPayment,
	processShopPaymentEvent,
	reconcilePendingShopPayments,
} from "#/features/shop-payments/server/service";
import { revealStoreDelivery } from "#/features/storefront/server/delivery-reveal";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const orderId = "11111111-1111-4111-8111-111111111111";
const orderItemId = "22222222-2222-4222-8222-222222222222";
const channelId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";

describe("shop payment fulfillment", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		await seedPayment(database);
	});

	afterEach(async () => miniflare.dispose());

	it("creates a converted payment with an immutable exchange-rate snapshot", async () => {
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("line_items[0][price_data][currency]")).toBe("usd");
				expect(body.get("line_items[0][price_data][unit_amount]")).toBe("140");
				return Response.json({
					id: "cs_converted",
					url: "https://checkout.stripe.example/cs_converted",
					expires_at: 1_900_000_000,
				});
			},
		);
		const input = {
			orderId,
			channelId,
			idempotencyKey: "create-payment-usd",
			paymentCurrency: "USD",
			successUrl: "https://shop.example/orders/GM100001",
			cancelUrl: "https://shop.example/orders/GM100001",
			payerIp: "2001:db8::10",
		};
		await expect(createShopPayment(database, input, fetcher)).resolves.toEqual({
			id: expect.any(String),
			status: "pending",
			providerPaymentId: "cs_converted",
			checkoutUrl: "https://checkout.stripe.example/cs_converted",
			expiresAt: 1_900_000_000_000,
		});
		await expect(
			createShopPayment(database, input, async () => {
				throw new Error("idempotency replay must not call provider");
			}),
		).resolves.toMatchObject({
			status: "pending",
			providerPaymentId: "cs_converted",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const snapshot = await database
			.prepare(
				`SELECT amount_minor, currency, currency_decimals, exchange_rate_id,
				 exchange_rate, exchange_rate_direction, exchange_rate_source,
				 exchange_rate_adjustment_bps, exchange_rate_observed_at
				 FROM payment_attempts WHERE idempotency_key = ?`,
			)
			.bind(input.idempotencyKey)
			.first<Record<string, unknown>>();
		expect(snapshot).toEqual({
			amount_minor: "140",
			currency: "USD",
			currency_decimals: 2,
			exchange_rate_id: "cny-usd",
			exchange_rate: "0.14",
			exchange_rate_direction: "multiply",
			exchange_rate_source: "manual",
			exchange_rate_adjustment_bps: 0,
			exchange_rate_observed_at: 1,
		});
	});

	it("grosses up customer payment when the selected channel charges a fee", async () => {
		await database
			.prepare("UPDATE payment_channels SET fee_bps = 300 WHERE id = ?")
			.bind(channelId)
			.run();
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("line_items[0][price_data][unit_amount]")).toBe("1031");
				return Response.json({
					id: "cs_channel_fee",
					url: "https://checkout.stripe.example/cs_channel_fee",
					expires_at: null,
				});
			},
		);
		await createShopPayment(
			database,
			{
				orderId,
				channelId,
				idempotencyKey: "create-payment-channel-fee",
				paymentCurrency: "CNY",
				successUrl: "https://shop.example/orders/GM100001",
				cancelUrl: "https://shop.example/orders/GM100001",
				payerIp: "192.0.2.10",
			},
			fetcher,
		);
		await expect(
			database
				.prepare(
					"SELECT amount_minor FROM payment_attempts WHERE idempotency_key = ?",
				)
				.bind("create-payment-channel-fee")
				.first(),
		).resolves.toEqual({ amount_minor: "1031" });
	});

	it("does not add a channel fee after a fixed channel price was snapshotted", async () => {
		await database.batch([
			database
				.prepare("UPDATE payment_channels SET fee_bps = 300 WHERE id = ?")
				.bind(channelId),
			database
				.prepare(
					`INSERT INTO sellable_item_channel_prices
					 (id,sellable_item_id,channel_id,price_minor,enabled,created_at,updated_at)
					 VALUES ('fixed-channel-payment','sellableItem-card',?,'1000',1,1,1)`,
				)
				.bind(channelId),
		]);
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("line_items[0][price_data][unit_amount]")).toBe("1000");
				return Response.json({
					id: "cs_fixed_channel_price",
					url: "https://checkout.stripe.example/cs_fixed_channel_price",
					expires_at: null,
				});
			},
		);
		await createShopPayment(
			database,
			{
				orderId,
				channelId,
				idempotencyKey: "create-payment-fixed-channel-price",
				paymentCurrency: "CNY",
				successUrl: "https://shop.example/orders/GM100001",
				cancelUrl: "https://shop.example/orders/GM100001",
				payerIp: "192.0.2.10",
			},
			fetcher,
		);
	});

	it("claims concurrent payment creation once before calling the provider", async () => {
		let releaseProvider: (() => void) | undefined;
		let providerStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			providerStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseProvider = resolve;
		});
		const fetcher = vi.fn(async () => {
			providerStarted?.();
			await release;
			return Response.json({
				id: "cs_concurrent_create",
				url: "https://checkout.stripe.example/cs_concurrent_create",
				expires_at: null,
			});
		});
		const input = {
			orderId,
			channelId,
			idempotencyKey: "create-payment-concurrent",
			paymentCurrency: "CNY",
			successUrl: "https://shop.example/orders/GM100001",
			cancelUrl: "https://shop.example/orders/GM100001",
			payerIp: null,
		};
		const first = createShopPayment(database, input, fetcher);
		await started;
		await expect(createShopPayment(database, input, fetcher)).resolves.toEqual({
			id: expect.any(String),
			status: "created",
			providerPaymentId: null,
			checkoutUrl: null,
			expiresAt: null,
		});
		releaseProvider?.();
		await expect(first).resolves.toMatchObject({
			status: "pending",
			providerPaymentId: "cs_concurrent_create",
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		const count = await database
			.prepare(
				"SELECT COUNT(*) AS total FROM payment_attempts WHERE idempotency_key = ?",
			)
			.bind(input.idempotencyKey)
			.first<{ total: number }>();
		expect(count?.total).toBe(1);
	});

	it("rejects reuse of a payment idempotency key outside its original scope", async () => {
		await expect(
			createShopPayment(database, {
				orderId,
				channelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				idempotencyKey: "payment-attempt-1",
				paymentCurrency: "CNY",
				successUrl: "https://shop.example/orders/GM100001",
				cancelUrl: "https://shop.example/orders/GM100001",
				payerIp: null,
			}),
		).rejects.toMatchObject({
			code: "payment_idempotency_conflict",
			status: 409,
		});
	});

	it("atomically records payment, reserves card stock and creates delivery", async () => {
		await expect(
			processShopPaymentEvent(database, channelId, succeededEvent("evt_1")),
		).resolves.toEqual({ duplicate: false, status: "succeeded" });
		const state = await database
			.prepare(
				`SELECT o.status, o.paid_minor, o.version, pa.status AS payment_status,
				 cs.status AS card_status, cs.order_item_id,
				 dr.status AS delivery_status, dr.error_code,
				 (SELECT COUNT(*) FROM replay_receipts
				  WHERE namespace = 'payment_webhook') AS replay_receipts,
				 (SELECT COUNT(*) FROM shop_order_events) AS order_events,
				 (SELECT COUNT(*) FROM outbox_events) AS outbox,
				 (SELECT COUNT(*) FROM outbox_events delivery_outbox
				  WHERE delivery_outbox.event_type = 'delivery.requested'
				   AND delivery_outbox.aggregate_id = dr.id
				   AND delivery_outbox.idempotency_key = 'delivery-requested:' || dr.id
				  ) AS delivery_outbox
				 FROM shop_orders o JOIN payment_attempts pa ON pa.order_id = o.id
				 JOIN stock_entries cs ON cs.sellable_item_id = 'sellableItem-card'
				 JOIN delivery_records dr ON dr.order_item_id = ? WHERE o.id = ?`,
			)
			.bind(orderItemId, orderId)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "paid",
			paid_minor: "1000",
			version: 2,
			payment_status: "succeeded",
			card_status: "reserved",
			order_item_id: orderItemId,
			delivery_status: "pending",
			error_code: null,
			replay_receipts: 1,
			order_events: 1,
			outbox: 2,
			delivery_outbox: 1,
		});
	});

	it("matches a ZPay callback by merchant order id when create omitted its trade number", async () => {
		const merchantOrderId = "44444444444444448444444444444444";
		await database
			.prepare(
				"UPDATE payment_attempts SET provider_payment_id = ? WHERE id = ?",
			)
			.bind(`${merchantOrderId}:${merchantOrderId}`, attemptId)
			.run();
		await expect(
			processShopPaymentEvent(database, channelId, {
				...succeededEvent("evt-zpay-merchant-fallback"),
				providerPaymentId: `zpay-trade-number:${merchantOrderId}`,
				merchantOrderId,
			}),
		).resolves.toEqual({ duplicate: false, status: "succeeded" });
		await expect(paymentState(database)).resolves.toMatchObject({
			order_status: "paid",
			payment_status: "succeeded",
			receipts: 1,
		});
	});

	it("accepts a verified late callback after the local order expired", async () => {
		await database.batch([
			database
				.prepare(
					"UPDATE shop_orders SET status = 'expired', version = 2, cancelled_at = 2 WHERE id = ?",
				)
				.bind(orderId),
			database
				.prepare(
					"UPDATE payment_attempts SET status = 'expired', failure_code = 'order_expired' WHERE id = ?",
				)
				.bind(attemptId),
		]);
		await expect(
			processShopPaymentEvent(
				database,
				channelId,
				succeededEvent("evt-late-payment"),
			),
		).resolves.toEqual({ duplicate: false, status: "succeeded" });
		const state = await database
			.prepare(
				`SELECT o.status AS order_status,o.version,o.cancelled_at,
				 pa.status AS payment_status,pa.failure_code,
				 (SELECT COUNT(*) FROM delivery_records WHERE order_item_id = ?) deliveries
				 FROM shop_orders o JOIN payment_attempts pa ON pa.order_id=o.id
				 WHERE o.id=?`,
			)
			.bind(orderItemId, orderId)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			order_status: "paid",
			version: 3,
			cancelled_at: null,
			payment_status: "succeeded",
			failure_code: null,
			deliveries: 1,
		});
	});

	it("reconciles a paid ZPay order when its callback was missed", async () => {
		const credential = await encryptSecret(
			JSON.stringify({
				baseUrl: "https://zpay.example",
				pid: "1000",
				secretKey: "zpay-secret-key",
				paymentMethod: "alipay",
			}),
			"commerce-test-secret",
			"payment-credential",
		);
		await database.batch([
			database
				.prepare(
					"UPDATE payment_channels SET provider='epay',credential_encrypted=? WHERE id=?",
				)
				.bind(credential, channelId),
			database
				.prepare(
					"UPDATE payment_attempts SET provider_payment_id='merchant-order:merchant-order' WHERE id=?",
				)
				.bind(attemptId),
		]);
		const fetcher = vi.fn(async () => Response.json({ code: 1, status: 1 }));
		await expect(
			reconcilePendingShopPayments(database, fetcher, 1_000),
		).resolves.toEqual({ scanned: 1, succeeded: 1, pending: 0, failed: 0 });
		expect(fetcher).toHaveBeenCalledTimes(1);
		await expect(paymentState(database)).resolves.toMatchObject({
			order_status: "paid",
			payment_status: "succeeded",
			receipts: 1,
		});
	});

	it("accepts payment for manual procurement and delivers operator-supplied content", async () => {
		await database.batch([
			database
				.prepare(
					"UPDATE product_sellable_items SET fulfillment_source = 'manual', supplier_status = NULL WHERE id = 'sellableItem-card'",
				)
				.bind(),
			database
				.prepare(
					"DELETE FROM stock_entries WHERE sellable_item_id = 'sellableItem-card'",
				)
				.bind(),
		]);
		await expect(
			processShopPaymentEvent(
				database,
				channelId,
				succeededEvent("evt_manual_delivery"),
			),
		).resolves.toEqual({ duplicate: false, status: "succeeded" });
		const waiting = await database
			.prepare(
				`SELECT dr.id, dr.status,
				 (SELECT COUNT(*) FROM supplier_orders WHERE order_item_id = ?) AS supplier_orders,
				 (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = dr.id) AS delivery_outbox
				 FROM delivery_records dr WHERE dr.order_item_id = ?`,
			)
			.bind(orderItemId, orderItemId)
			.first<{
				id: string;
				status: string;
				supplier_orders: number;
				delivery_outbox: number;
			}>();
		expect(waiting).toMatchObject({
			status: "awaiting_supply",
			supplier_orders: 0,
			delivery_outbox: 0,
		});
		await expect(
			completeManualDelivery(
				database,
				waiting?.id ?? "",
				"https://shop.example/redeem/MANUAL-CDK-1234",
			),
		).resolves.toMatchObject({
			status: "delivered",
			orderStatus: "completed",
			duplicate: false,
		});
		const completed = await database
			.prepare(
				`SELECT dr.content_encrypted, dr.status AS delivery_status,
				 o.status AS order_status,
				 (SELECT COUNT(*) FROM outbox_events
				  WHERE event_type = 'delivery.ready' AND aggregate_id = dr.id) AS ready_events
				 FROM delivery_records dr JOIN shop_order_items oi ON oi.id = dr.order_item_id
				 JOIN shop_orders o ON o.id = oi.order_id WHERE dr.id = ?`,
			)
			.bind(waiting?.id)
			.first<Record<string, unknown>>();
		expect(completed).toMatchObject({
			delivery_status: "delivered",
			order_status: "completed",
			ready_events: 1,
		});
		expect(
			await decryptDeliveryContent(
				String(completed?.content_encrypted),
				"commerce-test-secret",
			),
		).toBe("https://shop.example/redeem/MANUAL-CDK-1234");
	});

	it("makes provider event replay idempotent", async () => {
		await processShopPaymentEvent(database, channelId, succeededEvent("evt_1"));
		await expect(
			processShopPaymentEvent(database, channelId, succeededEvent("evt_1")),
		).resolves.toEqual({ duplicate: true, status: "processed" });
		const counts = await database
			.prepare(
				`SELECT (SELECT COUNT(*) FROM replay_receipts
				 WHERE namespace = 'payment_webhook') AS events,
				 (SELECT COUNT(*) FROM delivery_records) AS deliveries,
				 (SELECT COUNT(*) FROM stock_entries WHERE status = 'reserved') AS reserved`,
			)
			.first<Record<string, number>>();
		expect(counts).toEqual({ events: 1, deliveries: 1, reserved: 1 });
	});

	it("accepts concurrent delivery of the same provider event exactly once", async () => {
		const results = await Promise.allSettled([
			processShopPaymentEvent(
				database,
				channelId,
				succeededEvent("evt_concurrent_duplicate"),
			),
			processShopPaymentEvent(
				database,
				channelId,
				succeededEvent("evt_concurrent_duplicate"),
			),
		]);
		expect(results.every((result) => result.status === "fulfilled")).toBe(true);
		const fulfilled = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		);
		expect(fulfilled).toContainEqual({ duplicate: false, status: "succeeded" });
		expect(fulfilled).toContainEqual({ duplicate: true, status: "processed" });
		const counts = await database
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM replay_receipts
				  WHERE namespace = 'payment_webhook') AS receipts,
				 (SELECT COUNT(*) FROM delivery_records) AS deliveries,
				 (SELECT COUNT(*) FROM stock_entries WHERE status = 'reserved') AS reserved`,
			)
			.first<Record<string, number>>();
		expect(counts).toEqual({ receipts: 1, deliveries: 1, reserved: 1 });
	});

	it("rejects reuse of a provider event identifier with different content", async () => {
		await processShopPaymentEvent(
			database,
			channelId,
			succeededEvent("evt_reused"),
		);
		await expect(
			processShopPaymentEvent(database, channelId, {
				...succeededEvent("evt_reused"),
				payloadDigest: "different-payload-digest",
			}),
		).rejects.toMatchObject({
			code: "payment_replay_conflict",
			status: 409,
		});
		const counts = await database
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM replay_receipts
				  WHERE namespace = 'payment_webhook') AS receipts,
				 (SELECT COUNT(*) FROM delivery_records) AS deliveries`,
			)
			.first<Record<string, number>>();
		expect(counts).toEqual({ receipts: 1, deliveries: 1 });
	});

	it("rejects a signed success event whose money does not match the attempt", async () => {
		await expect(
			processShopPaymentEvent(database, channelId, {
				...succeededEvent("evt_wrong_money"),
				amountMinor: "999",
			}),
		).rejects.toMatchObject({
			code: "payment_amount_mismatch",
			status: 400,
		});
		const state = await database
			.prepare(
				`SELECT o.status AS order_status, pa.status AS payment_status,
				 (SELECT COUNT(*) FROM replay_receipts
				  WHERE namespace = 'payment_webhook') AS receipts,
				 (SELECT COUNT(*) FROM delivery_records) AS deliveries
				 FROM shop_orders o JOIN payment_attempts pa ON pa.id = ?
				 WHERE o.id = ?`,
			)
			.bind(attemptId, orderId)
			.first<Record<string, unknown>>();
		expect(state).toEqual({
			order_status: "pending_payment",
			payment_status: "pending",
			receipts: 0,
			deliveries: 0,
		});
	});

	it("records a pending provider event without ending the payment attempt", async () => {
		await expect(
			processShopPaymentEvent(database, channelId, {
				...succeededEvent("cryptomus:pending"),
				type: "payment_pending",
			}),
		).resolves.toEqual({ duplicate: false, status: "pending" });
		const state = await paymentState(database);
		expect(state).toEqual({
			order_status: "pending_payment",
			payment_status: "pending",
			receipts: 1,
			deliveries: 0,
		});
	});

	it("fails a wrong-amount event without allocating stock or fulfillment", async () => {
		await expect(
			processShopPaymentEvent(database, channelId, {
				...succeededEvent("cryptomus:wrong_amount"),
				type: "payment_failed",
			}),
		).resolves.toEqual({ duplicate: false, status: "failed" });
		const state = await paymentState(database);
		expect(state).toEqual({
			order_status: "pending_payment",
			payment_status: "failed",
			receipts: 1,
			deliveries: 0,
		});
	});

	it("never allocates the final card to two concurrent payments", async () => {
		const secondOrderId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const secondItemId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		await database.batch([
			database
				.prepare(
					`INSERT INTO shop_orders
				 (id, order_number, contact_email, normalized_contact_email,
				  status, currency, currency_decimals, subtotal_minor, total_minor, expires_at,
				  created_at, updated_at)
				 VALUES (?, 'GM100002', 'second@example.com',
				  'second@example.com', 'pending_payment', 'CNY', 2, '1000', '1000',
				  9999999999999, 2, 2)`,
				)
				.bind(secondOrderId),
			database
				.prepare(
					`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
				  delivery_component_type, delivery_component_version,
				  sellable_item_name, quantity, unit_price_minor,
				  discount_minor, subtotal_minor, created_at, updated_at)
				 VALUES (?, ?, 'product-card', 'sellableItem-card', 'Card', 'sellableItem-card', 'stock', 1,
				  'Default', 1, '1000', '0', '1000', 2, 2)`,
				)
				.bind(secondItemId, secondOrderId),
			database
				.prepare(
					`INSERT INTO payment_attempts
				 (id, order_id, channel_id, provider_payment_id, idempotency_key, status,
				  amount_minor, currency, created_at, updated_at)
				 VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', ?, ?, 'cs_test_2',
				  'payment-attempt-2', 'pending', '1000', 'CNY', 2, 2)`,
				)
				.bind(secondOrderId, channelId),
		]);
		const results = await Promise.allSettled([
			processShopPaymentEvent(
				database,
				channelId,
				succeededEvent("evt-concurrent-1", "cs_test_1"),
			),
			processShopPaymentEvent(
				database,
				channelId,
				succeededEvent("evt-concurrent-2", "cs_test_2"),
			),
		]);
		expect(results.every((result) => result.status === "fulfilled")).toBe(true);
		const state = await database
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM stock_entries WHERE status = 'reserved') AS reserved,
				 (SELECT COUNT(*) FROM delivery_records WHERE status = 'pending') AS pending,
				 (SELECT COUNT(*) FROM delivery_records
				  WHERE status = 'failed' AND error_code = 'inventory_unavailable') AS failed`,
			)
			.first<Record<string, number>>();
		expect(state).toEqual({ reserved: 1, pending: 1, failed: 1 });
	});

	it("delivers reserved card content without putting plaintext in the outbox", async () => {
		await processShopPaymentEvent(
			database,
			channelId,
			succeededEvent("evt_delivery"),
		);
		const delivery = await database
			.prepare("SELECT id FROM delivery_records WHERE order_item_id = ?")
			.bind(orderItemId)
			.first<{ id: string }>();
		await expect(
			processDelivery(database, delivery?.id ?? ""),
		).resolves.toMatchObject({ status: "delivered", orderStatus: "completed" });
		const state = await database
			.prepare(
				`SELECT dr.content_encrypted, dr.status AS delivery_status,
				 cs.status AS card_status, o.status AS order_status,
				 (SELECT payload FROM outbox_events WHERE aggregate_id = dr.id) AS payload,
				 (SELECT status FROM outbox_events
				  WHERE aggregate_id = dr.id AND event_type = 'delivery.requested'
				 ) AS request_status
				 FROM delivery_records dr JOIN shop_order_items oi ON oi.id = dr.order_item_id
				 JOIN shop_orders o ON o.id = oi.order_id
				 JOIN stock_entries cs ON cs.order_item_id = oi.id WHERE dr.id = ?`,
			)
			.bind(delivery?.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			delivery_status: "delivered",
			card_status: "delivered",
			order_status: "completed",
			request_status: "published",
		});
		expect(String(state?.payload)).not.toContain("CARD-SECRET-1234");
		expect(
			await decryptDeliveryContent(
				String(state?.content_encrypted),
				"commerce-test-secret",
			),
		).toBe("CARD-SECRET-1234");
		const revealed = await revealStoreDelivery(database, {
			orderNumber: "GM100001",
			email: "buyer@example.com",
			deliveryId: delivery?.id ?? "",
			request: new Request("https://shop.example/order", {
				headers: {
					"x-request-id": "reveal-request",
					"cf-connecting-ip": "192.0.2.10",
				},
			}),
		});
		expect(revealed).toEqual({ content: "CARD-SECRET-1234" });
		const audit = await database
			.prepare(
				"SELECT action, request_id, ip_address FROM audit_logs WHERE target_id = ?",
			)
			.bind(delivery?.id)
			.first<{ action: string; request_id: string; ip_address: string }>();
		expect(audit).toMatchObject({
			action: "delivery.content_viewed",
			request_id: "reveal-request",
			ip_address: "192.0.2.10",
		});
	});

	it("records an explicit recoverable delivery failure when card stock is short", async () => {
		await database.prepare("DELETE FROM stock_entries").run();
		await processShopPaymentEvent(
			database,
			channelId,
			succeededEvent("evt_short"),
		);
		const delivery = await database
			.prepare(
				"SELECT status, error_code FROM delivery_records WHERE order_item_id = ?",
			)
			.bind(orderItemId)
			.first<Record<string, unknown>>();
		expect(delivery).toEqual({
			status: "failed",
			error_code: "inventory_unavailable",
		});
	});
});

function succeededEvent(
	providerEventId: string,
	providerPaymentId = "cs_test_1",
): PaymentWebhookEvent {
	return {
		providerEventId,
		providerPaymentId,
		type: "payment_succeeded",
		amountMinor: "1000",
		currency: "CNY",
		payloadDigest: `digest-${providerEventId}`,
	};
}

async function paymentState(database: D1Database) {
	return database
		.prepare(
			`SELECT o.status AS order_status, pa.status AS payment_status,
			 (SELECT COUNT(*) FROM replay_receipts
			  WHERE namespace = 'payment_webhook') AS receipts,
			 (SELECT COUNT(*) FROM delivery_records) AS deliveries
			 FROM shop_orders o JOIN payment_attempts pa ON pa.id = ?
			 WHERE o.id = ?`,
		)
		.bind(attemptId, orderId)
		.first<Record<string, unknown>>();
}

async function seedPayment(database: D1Database) {
	const encryptedCard = await encryptSecret(
		"CARD-SECRET-1234",
		"commerce-test-secret",
		"stock-entry",
	);
	const encryptedCredential = await encryptSecret(
		JSON.stringify({
			secretKey: "sk_test_payment",
			webhookSecret: "whsec_test_payment",
		}),
		"commerce-test-secret",
		"payment-credential",
	);
	await database.batch([
		database.prepare(
			`INSERT INTO system_settings
			 (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.data_encryption_secret', '"commerce-test-secret"', 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO products
			 (id, name, product_type, status, sort_order, created_at, updated_at)
			 VALUES ('product-card', 'Card', 'stock', 'active', 100, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, currency, currency_decimals,
			  price_minor, minimum_quantity, maximum_quantity,
			  sort_order, enabled, created_at, updated_at)
			 VALUES ('sellableItem-card', 'product-card', 'Default',
			  'CNY', 2, '1000', 1, 1, 100, 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO users
			 (id, name, email, email_verified, created_at, updated_at)
			 VALUES ('customer-1', 'Buyer', 'buyer@example.com', 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO shop_orders
			 (id, order_number, user_id, contact_email, normalized_contact_email,
			  status, currency, currency_decimals, subtotal_minor, discount_minor,
			  total_minor, paid_minor, version, expires_at, created_at, updated_at)
			 VALUES ('${orderId}', 'GM100001', 'customer-1', 'buyer@example.com',
			  'buyer@example.com', 'pending_payment', 'CNY', 2, '1000', '0',
			  '1000', '0', 1, 9999999999999, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
			  delivery_component_type, delivery_component_version,
			  sellable_item_name, quantity, unit_price_minor,
			  discount_minor, subtotal_minor, created_at, updated_at)
			 VALUES ('${orderItemId}', '${orderId}', 'product-card', 'sellableItem-card', 'Card',
			  'sellableItem-card', 'stock', 1, 'Default', 1, '1000',
			  '0', '1000', 1, 1)`,
		),
		database
			.prepare(
				`INSERT INTO payment_channels
				 (id, provider, name, currency, credential_encrypted, fee_bps, fixed_fee_minor, sort_order,
				  enabled, last_health_status, created_at, updated_at)
				 VALUES ('${channelId}', 'stripe', 'Stripe', 'CNY', ?, 0, '0', 100, 1,
				  'healthy', 1, 1)`,
			)
			.bind(encryptedCredential),
		database.prepare(
			`INSERT INTO exchange_rates
			 (id, base_currency, quote_currency, raw_rate, rate, source, enabled,
			  adjustment_bps, sort_order, observed_at, created_at, updated_at)
			 VALUES ('cny-usd', 'CNY', 'USD', '0.14', '0.14', 'manual', 1,
			  0, 100, 1, 1, 1)`,
		),
		database.prepare(
			`INSERT INTO payment_attempts
			 (id, order_id, channel_id, provider_payment_id, idempotency_key, status,
			  amount_minor, currency, created_at, updated_at)
			 VALUES ('${attemptId}', '${orderId}', '${channelId}', 'cs_test_1',
			  'payment-attempt-1', 'pending', '1000', 'CNY', 1, 1)`,
		),
		database
			.prepare(
				`INSERT INTO stock_entries
			 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint,
			  content_mask, status, created_at, updated_at)
			 VALUES ('card-1', 'sellableItem-card', ?, 1, 'fingerprint-1',
			  '••••1234', 'available', 1, 1)`,
			)
			.bind(encryptedCard),
	]);
}
