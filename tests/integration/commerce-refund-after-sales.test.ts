import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	openAfterSaleCase,
	updateAfterSaleCase,
} from "#/features/shop-orders/server/after-sales";
import {
	completeManualShopRefund,
	processShopRefund,
	publishPendingRefunds,
	requestShopRefund,
} from "#/features/shop-payments/server/refunds";
import { encryptSecret } from "#/lib/secrets";
import type { RefundQueueMessage } from "#/server/queue/types";
import { applyMigrations } from "./migrations";

const ids = {
	admin: "00000000-0000-4000-8000-000000000001",
	user: "00000000-0000-4000-8000-000000000002",
	order: "00000000-0000-4000-8000-000000000004",
	item: "00000000-0000-4000-8000-000000000005",
	channel: "00000000-0000-4000-8000-000000000006",
	attempt: "00000000-0000-4000-8000-000000000007",
} as const;

describe("commerce refunds and after-sale cases", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db);
	});

	afterEach(async () => miniflare.dispose());

	it("reserves refundable balance once under concurrent requests", async () => {
		const results = await Promise.allSettled([
			requestShopRefund(
				db,
				{
					orderId: ids.order,
					amountMinor: "700",
					reason: "First concurrent request",
					idempotencyKey: "refund-concurrent-first",
				},
				{ actorUserId: ids.admin, request: testRequest() },
			),
			requestShopRefund(
				db,
				{
					orderId: ids.order,
					amountMinor: "700",
					reason: "Second concurrent request",
					idempotencyKey: "refund-concurrent-second",
				},
				{ actorUserId: ids.admin, request: testRequest() },
			),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		const state = await db
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM refunds) AS refunds,
				 (SELECT COALESCE(SUM(CAST(amount_minor AS INTEGER)), 0)
				  FROM refunds) AS reserved_minor,
				 (SELECT COUNT(*) FROM outbox_events
				  WHERE event_type = 'refund.requested') AS outbox,
				 (SELECT COUNT(*) FROM audit_logs
				  WHERE action = 'refund.requested') AS audits`,
			)
			.first<Record<string, number>>();
		expect(state).toEqual({
			refunds: 1,
			reserved_minor: 700,
			outbox: 1,
			audits: 1,
		});
	});

	it("processes partial and full refunds through durable idempotent outbox jobs", async () => {
		let refundSequence = 0;
		const refundFetcher = vi.fn(async () =>
			Response.json({
				id: `re_test_${++refundSequence}`,
				status: "succeeded",
				failure_reason: null,
			}),
		);
		const first = await requestShopRefund(
			db,
			{
				orderId: ids.order,
				amountMinor: "400",
				reason: "Customer request",
				idempotencyKey: "refund-first-request",
			},
			{ actorUserId: ids.admin, request: testRequest() },
		);
		await expect(
			requestShopRefund(
				db,
				{
					orderId: ids.order,
					amountMinor: "400",
					reason: "Customer request",
					idempotencyKey: "refund-first-request",
				},
				{ actorUserId: ids.admin, request: testRequest() },
			),
		).resolves.toMatchObject({ id: first.id, duplicate: true });
		const queued: RefundQueueMessage[] = [];
		const queue = {
			sendBatch: vi.fn(
				async (messages: Array<{ body: RefundQueueMessage }>) => {
					queued.push(...messages.map(({ body }) => body));
				},
			),
		} as unknown as Queue<RefundQueueMessage>;
		await expect(publishPendingRefunds(db, queue)).resolves.toEqual({
			published: 1,
		});
		expect(queued[0]).toEqual({
			kind: "commerce.refund",
			version: 1,
			refundId: first.id,
		});
		await expect(
			processShopRefund(db, first.id, refundFetcher),
		).resolves.toMatchObject({
			status: "succeeded",
			duplicate: false,
		});
		let order = await orderState(db);
		expect(order).toMatchObject({ status: "completed", version: 3 });

		const second = await requestShopRefund(
			db,
			{
				orderId: ids.order,
				amountMinor: "600",
				reason: "Refund remaining balance",
				idempotencyKey: "refund-second-request",
			},
			{ actorUserId: ids.admin, request: testRequest() },
		);
		await expect(
			processShopRefund(db, second.id, refundFetcher),
		).resolves.toMatchObject({
			status: "succeeded",
		});
		order = await orderState(db);
		expect(order).toMatchObject({ status: "refunded", version: 5 });
		const state = await db
			.prepare(
				`SELECT
				 (SELECT COUNT(*) FROM refunds WHERE status = 'succeeded') AS refunds,
				 (SELECT COUNT(*) FROM outbox_events WHERE event_type = 'refund.succeeded') AS events,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'refund.processed') AS audits,
				 (SELECT status FROM stock_entries WHERE id = 'stock-refund') AS stock_status,
				 (SELECT order_item_id FROM stock_entries
				  WHERE id = 'stock-refund') AS stock_order_item_id`,
			)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			refunds: 2,
			events: 2,
			audits: 2,
			stock_status: "delivered",
			stock_order_item_id: ids.item,
		});
	});

	it("lets only one concurrent worker call the refund provider", async () => {
		const refund = await requestShopRefund(
			db,
			{
				orderId: ids.order,
				amountMinor: "1000",
				reason: "Concurrent worker regression",
				idempotencyKey: "refund-worker-race",
			},
			{ actorUserId: ids.admin, request: testRequest() },
		);
		const fetcher = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return Response.json({
				id: "re_concurrent_worker",
				status: "succeeded",
				failure_reason: null,
			});
		});
		const results = await Promise.all([
			processShopRefund(db, refund.id, fetcher),
			processShopRefund(db, refund.id, fetcher),
		]);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: "succeeded", duplicate: false }),
				expect.objectContaining({ duplicate: true }),
			]),
		);
		const state = await db
			.prepare(
				`SELECT r.status, o.status AS order_status,
				 (SELECT COUNT(*) FROM outbox_events WHERE event_type = 'refund.succeeded') AS events,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'refund.processed') AS audits
				 FROM refunds r JOIN shop_orders o ON o.id = r.order_id WHERE r.id = ?`,
			)
			.bind(refund.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "succeeded",
			order_status: "refunded",
			events: 1,
			audits: 1,
		});
	});

	it("prevents an expired worker from overwriting a newer refund attempt", async () => {
		const refund = await requestShopRefund(
			db,
			{
				orderId: ids.order,
				amountMinor: "1000",
				reason: "Expired worker regression",
				idempotencyKey: "refund-expired-worker",
			},
			{ actorUserId: ids.admin, request: testRequest() },
		);
		let signalFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			signalFirstStarted = resolve;
		});
		let releaseFirst: (() => void) | undefined;
		const firstMayFinish = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let calls = 0;
		const fetcher = vi.fn(async () => {
			calls += 1;
			if (calls === 1) {
				signalFirstStarted?.();
				await firstMayFinish;
				return Response.json({
					id: "re_expired_worker",
					status: "succeeded",
					failure_reason: null,
				});
			}
			return Response.json({
				id: "re_current_worker",
				status: "succeeded",
				failure_reason: null,
			});
		});
		const expiredWorker = processShopRefund(db, refund.id, fetcher);
		await firstStarted;
		await db
			.prepare("UPDATE refunds SET next_attempt_at = 0 WHERE id = ?")
			.bind(refund.id)
			.run();
		await expect(
			processShopRefund(db, refund.id, fetcher),
		).resolves.toMatchObject({
			status: "succeeded",
			duplicate: false,
		});
		releaseFirst?.();
		await expect(expiredWorker).resolves.toMatchObject({ duplicate: true });
		const state = await db
			.prepare(
				`SELECT r.status, r.provider_refund_id, r.attempt_count,
				 o.status AS order_status,
				 (SELECT COUNT(*) FROM outbox_events WHERE event_type = 'refund.succeeded') AS events,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'refund.processed') AS audits
				 FROM refunds r JOIN shop_orders o ON o.id = r.order_id WHERE r.id = ?`,
			)
			.bind(refund.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "succeeded",
			provider_refund_id: "re_current_worker",
			attempt_count: 2,
			order_status: "refunded",
			events: 1,
			audits: 1,
		});
	});

	it("refunds the provider currency with the immutable payment rate snapshot", async () => {
		await db.batch([
			db
				.prepare(
					"UPDATE shop_orders SET currency = 'CNY', currency_decimals = 2 WHERE id = ?",
				)
				.bind(ids.order),
			db
				.prepare(
					`UPDATE payment_attempts SET amount_minor = '140', currency = 'USD',
					 currency_decimals = 2, exchange_rate = '0.14',
					 exchange_rate_direction = 'multiply', exchange_rate_source = 'manual'
					 WHERE id = ?`,
				)
				.bind(ids.attempt),
		]);
		const providerAmounts: string[] = [];
		const fetcher = vi.fn(
			async (_url: RequestInfo | URL, init?: RequestInit) => {
				providerAmounts.push(
					new URLSearchParams(String(init?.body ?? "")).get("amount") ?? "",
				);
				return Response.json({
					id: `re_rate_${providerAmounts.length}`,
					status: "succeeded",
					failure_reason: null,
				});
			},
		);
		const first = await requestShopRefund(
			db,
			{
				orderId: ids.order,
				amountMinor: "400",
				reason: "Partial cross-currency refund",
				idempotencyKey: "refund-rate-snapshot-first",
			},
			{ actorUserId: ids.admin, request: testRequest() },
		);
		await processShopRefund(db, first.id, fetcher);

		// A later rate change must not alter either the remaining provider balance
		// or the amount sent for the final refund.
		await db
			.prepare(
				`INSERT INTO exchange_rates
				 (id, base_currency, quote_currency, raw_rate, rate, source,
				  adjustment_bps, sort_order, observed_at, created_at, updated_at)
				 VALUES (?, 'CNY', 'USD', '9.99', '9.99', 'new-market-rate',
				  0, 100, 2, 2, 2)`,
			)
			.bind(crypto.randomUUID())
			.run();
		const second = await requestShopRefund(
			db,
			{
				orderId: ids.order,
				amountMinor: "600",
				reason: "Remaining cross-currency refund",
				idempotencyKey: "refund-rate-snapshot-second",
			},
			{ actorUserId: ids.admin, request: testRequest() },
		);
		await processShopRefund(db, second.id, fetcher);

		expect(providerAmounts).toEqual(["56", "84"]);
		const refunds = await db
			.prepare(
				`SELECT amount_minor, currency, payment_amount_minor, payment_currency
				 FROM refunds ORDER BY created_at, id`,
			)
			.all<Record<string, unknown>>();
		expect(refunds.results).toEqual([
			expect.objectContaining({
				amount_minor: "400",
				currency: "CNY",
				payment_amount_minor: "56",
				payment_currency: "USD",
			}),
			expect.objectContaining({
				amount_minor: "600",
				currency: "CNY",
				payment_amount_minor: "84",
				payment_currency: "USD",
			}),
		]);
	});

	it("keeps GMPay and EPay refunds manual until an administrator confirms the external transfer", async () => {
		await db
			.prepare("UPDATE payment_channels SET provider = 'gmpay' WHERE id = ?")
			.bind(ids.channel)
			.run();
		await seedSuppliedSupplierOrder(db);
		const refund = await requestShopRefund(
			db,
			{
				orderId: ids.order,
				amountMinor: "1000",
				reason: "External provider refund",
				idempotencyKey: "manual-refund-request",
			},
			{ actorUserId: ids.admin, request: testRequest() },
		);
		expect(refund).toMatchObject({
			status: "processing",
			manualActionRequired: true,
		});
		const pending = await db
			.prepare(
				`SELECT status, failure_code,
				 (SELECT COUNT(*) FROM outbox_events WHERE event_type = 'refund.requested') AS queued
				 FROM refunds WHERE id = ?`,
			)
			.bind(refund.id)
			.first<Record<string, unknown>>();
		expect(pending).toMatchObject({
			status: "processing",
			failure_code: "manual_action_required",
			queued: 0,
		});
		await expect(
			completeManualShopRefund(db, refund.id, "EPUSDT-REFUND-42", false, {
				actorUserId: ids.admin,
				request: testRequest(),
			}),
		).rejects.toMatchObject({ code: "refund_funds_not_returned" });
		await expect(
			completeManualShopRefund(db, refund.id, "EPUSDT-REFUND-42", true, {
				actorUserId: ids.admin,
				request: testRequest(),
			}),
		).resolves.toMatchObject({ status: "succeeded", duplicate: false });
		await expect(
			completeManualShopRefund(db, refund.id, "EPUSDT-REFUND-42", true, {
				actorUserId: ids.admin,
				request: testRequest(),
			}),
		).resolves.toMatchObject({ status: "succeeded", duplicate: true });
		const completed = await db
			.prepare(
				`SELECT r.status, r.provider_refund_id, o.status AS order_status,
				 (SELECT state FROM supplier_orders WHERE order_id = o.id) AS supplier_state,
				 (SELECT COUNT(*) FROM audit_logs WHERE action = 'refund.manual_completed') AS audits
				 FROM refunds r JOIN shop_orders o ON o.id = r.order_id WHERE r.id = ?`,
			)
			.bind(refund.id)
			.first<Record<string, unknown>>();
		expect(completed).toMatchObject({
			status: "succeeded",
			provider_refund_id: "manual:EPUSDT-REFUND-42",
			order_status: "refunded",
			supplier_state: "supplied",
			audits: 1,
		});
	});

	it("routes exact ZPAY EPay credentials through the original-payment refund endpoint", async () => {
		await configureZpayChannel(db);
		const afterSale = await openAfterSaleCase(
			db,
			{
				orderId: ids.order,
				orderItemId: ids.item,
				type: "refund",
				reason: "Customer requests an original-route refund",
			},
			{ userId: ids.user, actorUserId: ids.user, request: testRequest() },
		);
		const refund = await requestShopRefund(
			db,
			{
				orderId: ids.order,
				amountMinor: "1000",
				reason: "Original route refund",
				idempotencyKey: "zpay-original-route-refund",
			},
			{ actorUserId: ids.admin, request: testRequest() },
		);
		expect(refund).toMatchObject({
			status: "pending",
			manualActionRequired: false,
		});
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					code: 1,
					status: 1,
					trade_no: "zpay-trade-actual",
					out_trade_no: "merchant-order-1",
					type: "alipay",
					money: "10.00",
				}),
			)
			.mockResolvedValueOnce(Response.json({ code: 1, msg: "退款成功" }));
		await expect(
			processShopRefund(db, refund.id, fetcher),
		).resolves.toMatchObject({ status: "succeeded", duplicate: false });
		await expect(orderState(db)).resolves.toMatchObject({ status: "refunded" });
		const afterSaleState = await db
			.prepare(
				`SELECT status,
				 (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = ?
				  AND event_type = 'after_sale.updated') AS update_events,
				 (SELECT COUNT(*) FROM audit_logs WHERE target_id = ?
				  AND action = 'after_sale.refund_closed') AS audits
				 FROM after_sale_cases WHERE id = ?`,
			)
			.bind(afterSale.id, afterSale.id, afterSale.id)
			.first<Record<string, unknown>>();
		expect(afterSaleState).toEqual({
			status: "closed",
			update_events: 1,
			audits: 1,
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("holds an ambiguous ZPAY response for manual reconciliation without retrying", async () => {
		await configureZpayChannel(db);
		const refund = await requestShopRefund(
			db,
			{
				orderId: ids.order,
				amountMinor: "1000",
				reason: "Ambiguous original route refund",
				idempotencyKey: "zpay-ambiguous-refund",
			},
			{ actorUserId: ids.admin, request: testRequest() },
		);
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					code: 1,
					status: 1,
					trade_no: "zpay-trade-actual",
					out_trade_no: "merchant-order-1",
					type: "alipay",
					money: "10.00",
				}),
			)
			.mockRejectedValueOnce(new TypeError("network closed"));
		await expect(
			processShopRefund(db, refund.id, fetcher),
		).resolves.toMatchObject({
			status: "processing",
			manualActionRequired: true,
		});
		const state = await db
			.prepare(
				`SELECT r.status, r.failure_code, r.next_attempt_at,
				 o.status AS order_status FROM refunds r
				 JOIN shop_orders o ON o.id = r.order_id WHERE r.id = ?`,
			)
			.bind(refund.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "processing",
			failure_code: "manual_action_required",
			next_attempt_at: null,
			order_status: "refunding",
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("enforces ownership, duplicate protection, and after-sale transitions", async () => {
		const opened = await openAfterSaleCase(
			db,
			{
				orderId: ids.order,
				orderItemId: ids.item,
				type: "redelivery",
				reason: "The delivered credential does not work",
			},
			{
				userId: ids.user,
				actorUserId: ids.user,
				request: testRequest(),
			},
		);
		await expect(
			openAfterSaleCase(
				db,
				{
					orderId: ids.order,
					orderItemId: ids.item,
					type: "redelivery",
					reason: "Duplicate active request",
				},
				{
					userId: ids.user,
					actorUserId: ids.user,
					request: testRequest(),
				},
			),
		).rejects.toMatchObject({ code: "after_sale_case_exists" });
		await expect(
			updateAfterSaleCase(
				db,
				{
					id: opened.id,
					status: "processing",
					resolution: "",
					note: "Reviewing",
				},
				{ actorUserId: ids.admin, request: testRequest() },
			),
		).resolves.toMatchObject({ status: "processing" });
		await expect(
			updateAfterSaleCase(
				db,
				{
					id: opened.id,
					status: "resolved",
					resolution: "A replacement was delivered",
					note: "Verified",
				},
				{ actorUserId: ids.admin, request: testRequest() },
			),
		).resolves.toMatchObject({ status: "resolved" });
		const state = await db
			.prepare(
				`SELECT c.status, c.resolution,
				 (SELECT COUNT(*) FROM shop_order_events
				  WHERE after_sale_case_id = c.id) AS records,
				 (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = c.id) AS events
				 FROM after_sale_cases c WHERE c.id = ?`,
			)
			.bind(opened.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			status: "resolved",
			resolution: "A replacement was delivered",
			records: 3,
			events: 3,
		});
	});
});

async function seed(db: D1Database) {
	const credential = await encryptSecret(
		JSON.stringify({
			secretKey: "sk_test_refund",
			webhookSecret: "whsec_test_refund",
		}),
		"commerce-test-secret",
		"payment-credential",
	);
	await db.batch([
		db.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES ('runtime.data_encryption_secret', '"commerce-test-secret"', 1, 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO users
			 (id, name, email, email_verified, enabled, created_at, updated_at)
			 VALUES (?, 'Admin', 'admin@example.com', 1, 1, 1, 1),
			 (?, 'Buyer', 'buyer@example.com', 1, 1, 1, 1)`,
			)
			.bind(ids.admin, ids.user),
		db
			.prepare(
				`INSERT INTO payment_channels
			 (id, provider, name, currency, credential_encrypted, credential_key_version,
			  enabled, created_at, updated_at) VALUES (?, 'stripe', 'Stripe', 'USD', ?, 1, 1, 1, 1)`,
			)
			.bind(ids.channel, credential),
		db.prepare(
			`INSERT INTO products
			 (id, name, description, product_type, status, created_at, updated_at)
			 VALUES ('product-refund', 'Credential', NULL, 'stock', 'active', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, price_minor, created_at, updated_at)
			 VALUES ('sellable-refund', 'product-refund', 'Default', '1000', 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO shop_orders
			 (id, order_number, user_id, contact_email,
			  normalized_contact_email, status, currency, currency_decimals,
			  subtotal_minor, discount_minor, total_minor, paid_minor, version,
			  expires_at, paid_at, completed_at, created_at, updated_at)
			 VALUES (?, 'ORDER-REFUND-1', ?, 'buyer@example.com',
			  'buyer@example.com', 'completed', 'USD', 2, '1000', '0', '1000',
			  '1000', 1, 999999, 1, 1, 1, 1)`,
			)
			.bind(ids.order, ids.user),
		db
			.prepare(
				`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, delivery_component_id,
			  product_name, delivery_component_type, delivery_component_version, sellable_item_name,
			  quantity, unit_price_minor, discount_minor, subtotal_minor,
			  created_at, updated_at)
			 VALUES (?, ?, 'product-refund', 'sellable-refund', 'sellable-refund',
			  'Credential', 'stock', 1, 'Default',
			  1, '1000', '0', '1000', 1, 1)`,
			)
			.bind(ids.item, ids.order),
		db
			.prepare(
				`INSERT INTO payment_attempts
			 (id, order_id, channel_id, idempotency_key, provider_payment_id, status,
			  amount_minor, currency, succeeded_at, created_at, updated_at)
				 VALUES (?, ?, ?, 'payment-attempt-1', 'pi_test_1', 'succeeded',
			  '1000', 'USD', 1, 1, 1)`,
			)
			.bind(ids.attempt, ids.order, ids.channel),
		db
			.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version,
				  content_fingerprint, content_mask, status, order_item_id,
				  reserved_at, delivered_at, created_at, updated_at)
				 VALUES ('stock-refund', 'sellable-refund', ?, 1,
				  'stock-refund-fingerprint', '••••1234', 'delivered', ?,
				  1, 1, 1, 1)`,
			)
			.bind("encrypted-stock-content", ids.item),
	]);
}

async function seedSuppliedSupplierOrder(db: D1Database) {
	await db.batch([
		db
			.prepare(
				`INSERT INTO delivery_records
			 (id, order_item_id, delivery_type, status, delivered_at, created_at, updated_at)
			 VALUES ('delivery-supplied-refund', ?, 'stock', 'delivered', 1, 1, 1)`,
			)
			.bind(ids.item),
		db.prepare(
			`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version,
			  currency, currency_decimals, name, credentials_encrypted,
			  credential_fingerprint, health_status, enabled, created_at, updated_at)
			 VALUES ('supplier-account-refund', 'acg', 'https://supplier.example',
			  'https://supplier.example', 'v1', 'USD', 2, 'Supplier',
			  'encrypted', 'supplier-refund-fingerprint', 'healthy', 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO supplier_bindings
			 (id, sellable_item_id, provider, normalized_api_origin, protocol_version,
			  upstream_product_id, upstream_sku_id, upstream_product_name,
			  upstream_sku_name, reference_cost_minor, max_cost_minor, stock_quantity,
			  remote_status, enabled, created_at, updated_at)
			 VALUES ('supplier-binding-refund', 'sellable-refund', 'acg',
			  'https://supplier.example', 'v1', 'product-upstream', 'sku-upstream',
			  'Credential', 'Default', '900', '900', 1, 'active', 1, 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO supplier_orders
			 (id, order_id, order_item_id, delivery_record_id, supplier_binding_id,
			  upstream_order_id, quantity, quoted_unit_cost_minor, total_cost_minor,
			  currency, binding_snapshot_json, state, supplied_at, created_at, updated_at)
			 VALUES ('supplier-order-refund', ?, ?, 'delivery-supplied-refund',
			  'supplier-binding-refund', 'upstream-refund-1', 1, '900', '900', 'USD',
			  '{}', 'supplied', 1, 1, 1)`,
			)
			.bind(ids.order, ids.item),
	]);
}

async function configureZpayChannel(db: D1Database) {
	const credential = await encryptSecret(
		JSON.stringify({
			baseUrl: "https://zpayz.cn",
			pid: "1000",
			secretKey: "epusdt_secret_key",
			paymentMethod: "alipay",
		}),
		"commerce-test-secret",
		"payment-credential",
	);
	await db.batch([
		db
			.prepare(
				`UPDATE payment_channels SET provider = 'epay', currency = 'CNY',
				 credential_encrypted = ? WHERE id = ?`,
			)
			.bind(credential, ids.channel),
		db
			.prepare("UPDATE shop_orders SET currency = 'CNY' WHERE id = ?")
			.bind(ids.order),
		db
			.prepare(
				`UPDATE payment_attempts SET currency = 'CNY',
				 provider_payment_id = 'pi_test_1:merchant-order-1' WHERE id = ?`,
			)
			.bind(ids.attempt),
	]);
}

function orderState(db: D1Database) {
	return db
		.prepare(
			"SELECT status, version, refunded_at FROM shop_orders WHERE id = ?",
		)
		.bind(ids.order)
		.first<Record<string, unknown>>();
}

function testRequest() {
	return new Request("https://shop.example/admin/orders", {
		headers: { "x-request-id": crypto.randomUUID() },
	});
}
