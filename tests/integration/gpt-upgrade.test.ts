import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import { processDelivery } from "#/features/fulfillment/server/process";
import { gptUpgradeProduct } from "#/features/gpt-upgrade/products";
import {
	processUpgradeDelivery,
	reconcileUpgradeDeliveries,
	upgradeDeliveryContent,
} from "#/features/gpt-upgrade/server/fulfillment";
import {
	decryptNotificationMessage,
	encryptNotificationConfig,
} from "#/features/notifications/secrets";
import { fanOutPendingCommerceNotifications } from "#/features/notifications/server/fanout";
import {
	completeWalletStoreOrder,
	createShopPayment,
	processShopPaymentEvent,
} from "#/features/shop-payments/server/service";
import { revealStoreDelivery } from "#/features/storefront/server/delivery-reveal";
import { createMultiStoreOrder } from "#/features/storefront/server/multi-order";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const { warehouse, alert } = vi.hoisted(() => ({
	warehouse: vi.fn(),
	alert: vi.fn(),
}));
vi.mock(
	"#/features/redeem-warehouse/server/warehouse-client",
	async (original) => ({
		...(await original<
			typeof import("#/features/redeem-warehouse/server/warehouse-client")
		>()),
		requestWarehouse: warehouse,
	}),
);
vi.mock("#/features/telegram/server/owner-alerts", () => ({
	sendOwnerAlert: alert,
}));
const secret = "fixture-upgrade-commerce-secret-32";
const quoteToken = "Q".repeat(43);
const quoteId = "aaaa0000-0000-4000-8000-000000000001";
const userId = "bbbb0000-0000-4000-8000-000000000001";
const channelId = "cccc0000-0000-4000-8000-000000000001";
const statusUrl = `https://redeem.laoshirenvip.com/upgrade/status/${"S".repeat(43)}`;
const quote = () => ({
	quote_id: quoteId,
	state: "open",
	target_plan: "pro20x",
	target_label: "ChatGPT Pro 200（Pro 20x）",
	source_label: "ChatGPT Plus",
	account_hint: "ab***@example.test",
	remaining_days: 16,
	price_minor: "121000",
	currency: "CNY",
	currency_decimals: 2,
	expires_at: Date.now() + 1_800_000,
});

describe("quoted ChatGPT upgrades", { timeout: 30_000 }, () => {
	let mf: Miniflare;
	let db: D1Database;
	beforeEach(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		// 0050 seeds the upgrade product only on the laoshirenvip catalog, anchored to this product.
		await db
			.prepare(
				"INSERT INTO products(id,name,product_type,status,sort_order) VALUES (?,'ChatGPT 会员充值','stock','active',200)",
			)
			.bind(chatgptProductId)
			.run();
		await seedUpgradeProduct(db);
		await db
			.prepare(
				"INSERT INTO system_settings(key,value) VALUES ('runtime.data_encryption_secret',?),('commerce.default_currency','\"CNY\"'),('integration.redeem_warehouse_token',?)",
			)
			.bind(
				JSON.stringify(secret),
				JSON.stringify(
					await encryptSecret(
						"fixture-warehouse-token",
						secret,
						"redeem-warehouse-token",
					),
				),
			)
			.run();
		await db
			.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled,balance_minor,balance_version) VALUES (?,'Buyer','buyer@example.test',1,1,'500000',1)",
			)
			.bind(userId)
			.run();
		const credential = await encryptSecret(
			JSON.stringify({
				secretKey: "sk_fixture_upgrade",
				webhookSecret: "whsec_fixture_upgrade",
			}),
			secret,
			"payment-credential",
		);
		await db
			.prepare(
				"INSERT INTO payment_channels(id,provider,name,currency,credential_encrypted,fee_bps,fixed_fee_minor,enabled) VALUES (?,'stripe','Stripe','CNY',?,500,'100',1)",
			)
			.bind(channelId, credential)
			.run();
		warehouse.mockReset();
		alert.mockReset();
		alert.mockResolvedValue(null);
		warehouse.mockImplementation(async (_token, path) => ({
			success: true,
			data: path.endsWith("/quote")
				? quote()
				: { upgrade_id: quoteId, state: "queued", status_url: statusUrl },
		}));
	}, 30_000);
	afterEach(async () => {
		await mf.dispose();
	});
	function make(overrides: Record<string, unknown> = {}, access = {}) {
		return createMultiStoreOrder(
			db,
			{
				items: [{ sellableItemId: gptUpgradeProduct.itemId, quantity: 1 }],
				email: "buyer@example.test",
				idempotencyKey: crypto.randomUUID(),
				upgradeQuoteToken: quoteToken,
				...overrides,
			},
			access,
		);
	}
	async function paid() {
		const order = await make({}, { userId });
		await completeWalletStoreOrder(db, { orderId: order.id, userId });
		const delivery = await db
			.prepare(
				"SELECT d.id,d.order_item_id FROM delivery_records d JOIN shop_order_items oi ON oi.id=d.order_item_id WHERE oi.order_id=?",
			)
			.bind(order.id)
			.first<{ id: string; order_item_id: string }>();
		if (!delivery) throw new Error("delivery missing");
		return { order, ...delivery };
	}
	it("prices a guest order only from the server quote, bypassing channel/customer/volume prices and encrypting its token", async () => {
		await db
			.prepare(
				"INSERT INTO sellable_item_channel_prices(id,sellable_item_id,channel_id,price_minor,enabled,created_at,updated_at) VALUES ('fixture-channel-price',?,?,'999',1,1,1)",
			)
			.bind(gptUpgradeProduct.itemId, channelId)
			.run();
		await db
			.prepare(
				"INSERT INTO sellable_item_volume_prices(sellable_item_id,min_quantity,discount_minor,created_at,updated_at) VALUES (?,2,'500',1,1)",
			)
			.bind(gptUpgradeProduct.itemId)
			.run();
		const order = await make(
			{ price_minor: "1" },
			{ pricingChannelId: channelId },
		);
		expect(order.totalMinor).toBe("121000");
		const row = await db
			.prepare(
				"SELECT u.*,oi.unit_price_minor FROM gpt_upgrade_orders u JOIN shop_order_items oi ON oi.id=u.order_item_id",
			)
			.first<{
				quote_token_encrypted: string;
				price_minor: string;
				unit_price_minor: string;
			}>();
		expect(row).toMatchObject({
			price_minor: "121000",
			unit_price_minor: "121000",
		});
		expect(row?.quote_token_encrypted).not.toContain(quoteToken);
		expect(
			await decryptSecret(
				row?.quote_token_encrypted ?? "",
				secret,
				"gpt-upgrade-quote",
			),
		).toBe(quoteToken);
		expect(warehouse).toHaveBeenCalledWith(
			"fixture-warehouse-token",
			"/api/internal/upgrade/quote",
			{ method: "POST", body: JSON.stringify({ quote_token: quoteToken }) },
		);
		expect(order.expiresAt).toBeLessThanOrEqual(quote().expires_at);
	});
	it("ignores a logged-in customer's special price", async () => {
		await db
			.prepare(
				"INSERT INTO customer_item_prices(id,user_id,sellable_item_id,price_minor) VALUES ('fixture-customer-price',?,?,'1')",
			)
			.bind(userId, gptUpgradeProduct.itemId)
			.run();
		await expect(make({}, { userId })).resolves.toMatchObject({
			totalMinor: "121000",
		});
	});
	it.each([
		{ couponCode: "SAVE" },
		{ upgradeQuoteToken: undefined },
		{ items: [{ sellableItemId: gptUpgradeProduct.itemId, quantity: 2 }] },
		{
			items: [
				{ sellableItemId: gptUpgradeProduct.itemId, quantity: 1 },
				{ sellableItemId: userId, quantity: 1 },
			],
		},
		{
			items: [
				{
					sellableItemId: gptUpgradeProduct.itemId,
					quantity: 1,
					renewedFromEntitlementId: userId,
				},
			],
		},
	])("rejects invalid upgrade checkout %j before calling the warehouse", async (input) => {
		await expect(make(input)).rejects.toMatchObject({
			code: "upgrade_checkout_invalid",
		});
		expect(warehouse).not.toHaveBeenCalled();
	});
	it.each([
		"paid",
		"expired",
		"elapsed",
	])("rejects %s quotes", async (state) => {
		warehouse.mockResolvedValue({
			success: true,
			data: {
				...quote(),
				state: state === "elapsed" ? "open" : state,
				expires_at: state === "elapsed" ? Date.now() - 1 : quote().expires_at,
			},
		});
		await expect(make()).rejects.toMatchObject({
			code: "upgrade_quote_expired",
		});
		expect(
			await db.prepare("SELECT COUNT(*) n FROM shop_orders").first<number>("n"),
		).toBe(0);
	});
	it("replays the same idempotency key without re-quoting and never creates a second active order", async () => {
		const idempotencyKey = crypto.randomUUID();
		const order = await make({ idempotencyKey });
		await expect(make({ idempotencyKey })).resolves.toMatchObject({
			id: order.id,
			duplicate: true,
			totalMinor: "121000",
		});
		expect(warehouse).toHaveBeenCalledTimes(1);
		await expect(make()).rejects.toMatchObject({
			code: "upgrade_existing_order",
		});
		expect(
			await db.prepare("SELECT COUNT(*) n FROM shop_orders").first<number>("n"),
		).toBe(1);
	});
	it("enforces uniqueness during concurrent different-key checkouts atomically", async () => {
		const results = await Promise.allSettled([make(), make()]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			await db
				.prepare("SELECT COUNT(*) n FROM shop_order_items")
				.first<number>("n"),
		).toBe(1);
	});
	it.each([
		"cancelled",
		"expired",
	])("releases %s unpaid quotes but retains paid reservations", async (status) => {
		const order = await make();
		await db
			.prepare("UPDATE shop_orders SET status=? WHERE id=?")
			.bind(status, order.id)
			.run();
		await expect(make()).resolves.toMatchObject({ totalMinor: "121000" });
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) n FROM gpt_upgrade_orders WHERE active_key IS NOT NULL",
				)
				.first<number>("n"),
		).toBe(1);
		await db
			.prepare(
				"UPDATE shop_orders SET status='cancelled',paid_minor='121000' WHERE id<>?",
			)
			.bind(order.id)
			.run();
		await expect(make()).rejects.toMatchObject({
			code: "upgrade_existing_order",
		});
	});
	it("delivers the fixed progress link once through the actual paid-order chain and makes it revealable", async () => {
		const d = await paid();
		await expect(processDelivery(db, d.id)).resolves.toMatchObject({
			status: "delivered",
		});
		await expect(processDelivery(db, d.id)).resolves.toMatchObject({
			status: "delivered",
		});
		expect(
			warehouse.mock.calls.filter((call) => call[1].endsWith("/paid")),
		).toHaveLength(1);
		expect(warehouse).toHaveBeenLastCalledWith(
			"fixture-warehouse-token",
			"/api/internal/upgrade/paid",
			{
				method: "POST",
				body: JSON.stringify({
					quote_token: quoteToken,
					order_number: d.order.orderNumber,
					order_item_id: d.order_item_id,
					paid_minor: "121000",
				}),
			},
		);
		const encrypted = await db
			.prepare("SELECT content_encrypted FROM delivery_records WHERE id=?")
			.bind(d.id)
			.first<string>("content_encrypted");
		expect(await decryptDeliveryContent(encrypted ?? "", secret)).toBe(
			upgradeDeliveryContent(statusUrl),
		);
		expect(
			await revealStoreDelivery(db, {
				orderNumber: d.order.orderNumber,
				deliveryId: d.id,
				userId,
			}),
		).toMatchObject({ content: upgradeDeliveryContent(statusUrl) });
		expect(
			await db
				.prepare("SELECT status FROM shop_orders WHERE id=?")
				.bind(d.order.id)
				.first<string>("status"),
		).toBe("completed");
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) n FROM outbox_events WHERE event_type='delivery.ready'",
				)
				.first<number>("n"),
		).toBe(1);
	});
	it("queues the fixed progress content in the normal delivery email without sending it", async () => {
		const d = await paid();
		await db
			.prepare(
				"INSERT INTO system_settings(key,value) VALUES ('runtime.better_auth_url','\"https://shop.example\"')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO notification_channel_configs(id,channel,name,provider,api_key_encrypted,api_key_version,from_address,enabled) VALUES ('fixture-email','email','Email','resend',?,1,'Shop <mail@example.test>',1)",
			)
			.bind(await encryptNotificationConfig("fixture-email-key", secret))
			.run();
		await processDelivery(db, d.id);
		await fanOutPendingCommerceNotifications(db);
		const encrypted = await db
			.prepare(
				"SELECT message_encrypted FROM notification_deliveries WHERE event='delivery_ready'",
			)
			.first<string>("message_encrypted");
		expect(encrypted).toBeTruthy();
		const text = JSON.parse(
			await decryptNotificationMessage(encrypted ?? "", secret),
		).text;
		expect(text).toContain(upgradeDeliveryContent(statusUrl));
		// Our own links are tagged; the invite line closes a storefront delivery email.
		expect(text).toMatch(
			/https:\/\/shop\.example\/account\/orders\/GM[0-9A-F]+\?utm_source=order_email&utm_medium=email&utm_campaign=delivery_ready\n/,
		);
		expect(
			text.endsWith(
				"\n\nInvite friends to order: they save, and you earn credit for your next purchase. Get your invite link: https://shop.example/account?utm_source=order_email&utm_medium=email&utm_campaign=delivery_invite",
			),
		).toBe(true);
	});
	it("still queues the delivery email without the invite line when the invite check fails", async () => {
		const d = await paid();
		await db
			.prepare(
				"INSERT INTO system_settings(key,value) VALUES ('runtime.better_auth_url','\"https://shop.example\"')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO notification_channel_configs(id,channel,name,provider,api_key_encrypted,api_key_version,from_address,enabled) VALUES ('fixture-email','email','Email','resend',?,1,'Shop <mail@example.test>',1)",
			)
			.bind(await encryptNotificationConfig("fixture-email-key", secret))
			.run();
		await processDelivery(db, d.id);
		// Break the invite eligibility query; the email must not depend on it.
		await db
			.prepare(
				"ALTER TABLE supplier_api_orders RENAME TO supplier_api_orders_off",
			)
			.run();
		await expect(fanOutPendingCommerceNotifications(db)).resolves.toMatchObject(
			{ deliveries: 1 },
		);
		const encrypted = await db
			.prepare(
				"SELECT message_encrypted FROM notification_deliveries WHERE event='delivery_ready'",
			)
			.first<string>("message_encrypted");
		expect(encrypted).toBeTruthy();
		const text = JSON.parse(
			await decryptNotificationMessage(encrypted ?? "", secret),
		).text;
		expect(text).toContain(upgradeDeliveryContent(statusUrl));
		expect(text).toContain("utm_campaign=delivery_ready");
		expect(text).not.toContain("delivery_invite");
		expect(text).not.toMatch(/invite|邀请/i);
	});
	it("backs off transient failures, suppresses duplicates, and recovers through the scheduler", async () => {
		const d = await paid();
		warehouse.mockRejectedValueOnce(
			new DomainError("redeem_warehouse_unreachable", 502, "unavailable"),
		);
		await expect(processUpgradeDelivery(db, d.id)).rejects.toMatchObject({
			code: "upgrade_delivery_pending",
		});
		const row = await db
			.prepare(
				"SELECT state,attempt_count,next_attempt_at FROM gpt_upgrade_orders",
			)
			.first<{
				state: string;
				attempt_count: number;
				next_attempt_at: number;
			}>();
		expect(row).toMatchObject({ state: "pending", attempt_count: 1 });
		expect(row?.next_attempt_at).toBeGreaterThan(Date.now() + 50_000);
		const calls = warehouse.mock.calls.length;
		await processUpgradeDelivery(db, d.id);
		expect(warehouse).toHaveBeenCalledTimes(calls);
		await db.prepare("UPDATE gpt_upgrade_orders SET next_attempt_at=0").run();
		await reconcileUpgradeDeliveries(db);
		expect(
			await db
				.prepare("SELECT state FROM gpt_upgrade_orders")
				.first<string>("state"),
		).toBe("delivered");
	});
	it.each([
		"upgrade.quote_already_paid",
		"upgrade.amount_mismatch",
	])("does not retry 409 %s and alerts operations", async (code) => {
		const d = await paid();
		warehouse.mockRejectedValue(
			new DomainError(`redeem_warehouse_http_409_${code}`, 502, "failed"),
		);
		await expect(processUpgradeDelivery(db, d.id)).resolves.toEqual({
			status: "needs_review",
		});
		await processUpgradeDelivery(db, d.id);
		expect(
			await db
				.prepare(
					"SELECT state,error_code,attempt_count FROM gpt_upgrade_orders",
				)
				.first(),
		).toMatchObject({
			state: "needs_review",
			error_code: `redeem_warehouse_http_409_${code}`,
			attempt_count: 1,
		});
		expect(alert).toHaveBeenCalledTimes(1);
	});
	it("stops after eight failed attempts", async () => {
		const d = await paid();
		await db.prepare("UPDATE gpt_upgrade_orders SET attempt_count=7").run();
		warehouse.mockRejectedValue(new Error("unavailable"));
		await processUpgradeDelivery(db, d.id);
		await processUpgradeDelivery(db, d.id);
		expect(
			await db
				.prepare("SELECT state,attempt_count FROM gpt_upgrade_orders")
				.first(),
		).toMatchObject({ state: "needs_review", attempt_count: 8 });
		expect(alert).toHaveBeenCalledTimes(1);
	});
	it("recovers an abandoned eighth-attempt lease to manual review without another remote call", async () => {
		await paid();
		await db
			.prepare(
				"UPDATE gpt_upgrade_orders SET attempt_count=8,next_attempt_at=0",
			)
			.run();
		const calls = warehouse.mock.calls.length;
		await reconcileUpgradeDeliveries(db);
		expect(warehouse).toHaveBeenCalledTimes(calls);
		expect(
			await db
				.prepare("SELECT state,error_code FROM gpt_upgrade_orders")
				.first(),
		).toMatchObject({
			state: "needs_review",
			error_code: "upgrade_delivery_exhausted",
		});
		expect(alert).toHaveBeenCalledOnce();
	});
	it("does not notify paid for unpaid, refunded, or refund-pending orders", async () => {
		const d = await paid();
		for (const status of ["pending_payment", "refunded", "cancelled"]) {
			await db
				.prepare("UPDATE shop_orders SET status=? WHERE id=?")
				.bind(status, d.order.id)
				.run();
			await processUpgradeDelivery(db, d.id);
		}
		await db
			.prepare("UPDATE shop_orders SET status='paid' WHERE id=?")
			.bind(d.order.id)
			.run();
		await db
			.prepare(
				"INSERT INTO refunds(id,order_id,idempotency_key,status,amount_minor,currency,payment_amount_minor,payment_currency,payment_currency_decimals,order_status_before,reason,created_at,updated_at) VALUES (?,?,?,'pending','121000','CNY','121000','CNY',2,'paid','fixture',1,1)",
			)
			.bind(crypto.randomUUID(), d.order.id, crypto.randomUUID())
			.run();
		await processUpgradeDelivery(db, d.id);
		expect(
			warehouse.mock.calls.filter((call) => call[1].endsWith("/paid")),
		).toHaveLength(0);
	});
	it("does not finalize delivery when a refund arrives during the remote call", async () => {
		const d = await paid();
		warehouse.mockImplementationOnce(async () => {
			await db
				.prepare("UPDATE shop_orders SET status='refunded' WHERE id=?")
				.bind(d.order.id)
				.run();
			return {
				success: true,
				data: { upgrade_id: quoteId, status_url: statusUrl, state: "queued" },
			};
		});
		await expect(processUpgradeDelivery(db, d.id)).resolves.toMatchObject({
			status: "waiting",
		});
		expect(
			await db
				.prepare("SELECT status FROM delivery_records WHERE id=?")
				.bind(d.id)
				.first<string>("status"),
		).not.toBe("delivered");
		expect(
			await db
				.prepare(
					"SELECT COUNT(*) n FROM outbox_events WHERE event_type='delivery.ready'",
				)
				.first<number>("n"),
		).toBe(0);
	});
	it("charges a guest the exact quote without per-channel prices or fees and fulfills after the real webhook", async () => {
		await db
			.prepare(
				"INSERT INTO sellable_item_channel_prices(id,sellable_item_id,channel_id,price_minor,enabled,created_at,updated_at) VALUES ('fixture-channel-price',?,?,'999',1,1,1)",
			)
			.bind(gptUpgradeProduct.itemId, channelId)
			.run();
		const order = await make();
		await createShopPayment(
			db,
			{
				orderId: order.id,
				channelId,
				idempotencyKey: crypto.randomUUID(),
				paymentCurrency: "CNY",
				successUrl: "https://shop.example/orders/success",
				cancelUrl: "https://shop.example/orders/cancel",
			},
			async (_input, init) => {
				const body = new URLSearchParams(String(init?.body));
				expect(body.get("line_items[0][price_data][unit_amount]")).toBe(
					"121000",
				);
				return Response.json({
					id: "cs_upgrade",
					url: "https://checkout.stripe.example/upgrade",
					expires_at: null,
				});
			},
		);
		await processShopPaymentEvent(db, channelId, {
			providerEventId: "evt_upgrade",
			providerPaymentId: "cs_upgrade",
			type: "payment_succeeded",
			amountMinor: "121000",
			currency: "CNY",
			payloadDigest: "fixture-upgrade-event",
		});
		const d = await db
			.prepare(
				"SELECT d.id FROM delivery_records d JOIN shop_order_items oi ON oi.id=d.order_item_id WHERE oi.order_id=?",
			)
			.bind(order.id)
			.first<{ id: string }>();
		expect(d).not.toBeNull();
		await processDelivery(db, d?.id ?? "");
		expect(
			await revealStoreDelivery(db, {
				orderNumber: order.orderNumber,
				deliveryId: d?.id ?? "",
				email: "buyer@example.test",
			}),
		).toMatchObject({ content: upgradeDeliveryContent(statusUrl) });
	});
	it("indexes quote reservations and due retries", async () => {
		const active = await db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT order_item_id FROM gpt_upgrade_orders WHERE active_key=?",
			)
			.bind(quoteId)
			.all<{ detail: string }>();
		expect(active.results.map((row) => row.detail).join(" ")).toContain(
			"USING INDEX",
		);
		const retries = await db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT order_item_id FROM gpt_upgrade_orders WHERE state='pending' AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT 20",
			)
			.bind(Date.now())
			.all<{ detail: string }>();
		expect(retries.results.map((row) => row.detail).join(" ")).toContain(
			"gpt_upgrade_orders_retry_idx",
		);
	});
	it("seeds right after the ChatGPT product in the first free gap without changing any existing product", async () => {
		await removeUpgradeProduct(db);
		await db
			.prepare("UPDATE products SET sort_order=10 WHERE id=?")
			.bind(chatgptProductId)
			.run();
		await db
			.prepare(
				"INSERT INTO products(id,name,product_type,status,sort_order) VALUES ('old-a','A','stock','active',5),('old-b','B','stock','active',11),('old-c','C','stock','active',20)",
			)
			.run();
		await seedUpgradeProduct(db);
		expect(
			(
				await db
					.prepare("SELECT id,sort_order FROM products ORDER BY sort_order")
					.all()
			).results,
		).toEqual([
			{ id: "old-a", sort_order: 5 },
			{ id: chatgptProductId, sort_order: 10 },
			{ id: "old-b", sort_order: 11 },
			{ id: gptUpgradeProduct.productId, sort_order: 12 },
			{ id: "old-c", sort_order: 20 },
		]);
	});
	it("does not seed the upgrade product on a catalog without the ChatGPT product", async () => {
		await removeUpgradeProduct(db);
		await db
			.prepare("DELETE FROM products WHERE id=?")
			.bind(chatgptProductId)
			.run();
		await seedUpgradeProduct(db);
		expect(
			(
				await db
					.prepare("SELECT COUNT(*) AS n FROM products")
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
		expect(
			(
				await db
					.prepare("SELECT COUNT(*) AS n FROM product_sellable_items")
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
	});
});

const chatgptProductId = "2a794b89-3bb9-49d4-8691-0d13a1606869";

async function seedUpgradeProduct(db: D1Database) {
	const sql = await readFile(
		new URL("../../drizzle/0050_gpt_upgrade.sql", import.meta.url),
		"utf8",
	);
	for (const statement of sql.split("--> statement-breakpoint").slice(2))
		await db.prepare(statement).run();
}

async function removeUpgradeProduct(db: D1Database) {
	await db
		.prepare("DELETE FROM product_sellable_items WHERE id=?")
		.bind(gptUpgradeProduct.itemId)
		.run();
	await db
		.prepare("DELETE FROM products WHERE id=?")
		.bind(gptUpgradeProduct.productId)
		.run();
}
