// Regression tests for the 2026-11-11 money audit (refund email, supplier 5xx,
// interrupted API cancel refund, late top-up success).
import { expect, test } from "bun:test";

const { openNodeDatabase } = await import("#/server/runtime/node/database");
const { applyNodeMigrations } = await import(
	"#/server/runtime/node/migrations"
);
const { createInitialRuntimeConfig, runtimeConfigEntries } = await import(
	"#/server/runtime-config"
);
const { createSupplierCredentialVault } = await import(
	"#/features/suppliers/secrets"
);
const { completeFreeStoreOrder, processShopPaymentEvent } = await import(
	"#/features/shop-payments/server/service"
);
const { processSupplierOrder } = await import(
	"#/features/suppliers/server/process"
);
const { createSupplierApiOrder, cancelSupplierApiOrder } = await import(
	"#/features/supplier-api/server/orders"
);
const { encryptSecret } = await import("#/lib/secrets");
async function fixture() {
	const db = openNodeDatabase(":memory:");
	await applyNodeMigrations(db);
	const runtime = createInitialRuntimeConfig("https://audit.example");
	await seed(db as any, runtime);
	return { db, runtime };
}

async function seed(
	db: D1Database,
	runtime: ReturnType<typeof createInitialRuntimeConfig>,
) {
	const now = 1_800_000_000_000;
	const encrypted = await createSupplierCredentialVault(
		"dujiao_next",
		{ apiKey: "api-key", apiSecret: "api-secret" },
		runtime.commerceSecret,
	);
	const settings = runtimeConfigEntries(runtime).map((entry) =>
		db
			.prepare(
				`INSERT INTO system_settings
				 (key, value, is_secret, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.bind(entry.key, JSON.stringify(entry.value), entry.isSecret, now, now),
	);
	await db.batch([
		...settings,
		db
			.prepare(
				`INSERT INTO products
			 (id, name, product_type, status, created_at, updated_at)
			 VALUES ('product', 'Product', 'stock', 'active', ?, ?)`,
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, supplier_status,
			  currency, currency_decimals, price_minor, created_at, updated_at)
			 VALUES ('item', 'product', 'SKU', 'supplier', 'available',
			  'USD', 2, '0', ?, ?)`,
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version,
			  currency, currency_decimals, name, credentials_encrypted,
			  credentials_revision, credential_fingerprint, balance_minor,
			  balance_synced_at, enabled, health_status, created_at, updated_at)
			 VALUES ('account', 'dujiao_next', 'https://supplier.example',
			  'https://supplier.example', '1.3.1-upstream-v1', 'CNY', 2,
			  'Account', ?, 1, 'fingerprint', '10000', ?, 1, 'healthy', ?, ?)`,
			)
			.bind(encrypted, now, now, now),
		db
			.prepare(
				`INSERT INTO supplier_bindings
			 (id, sellable_item_id, provider, normalized_api_origin,
			  protocol_version, upstream_product_id, upstream_sku_id,
			  upstream_product_name, upstream_sku_name, reference_cost_minor,
			  max_cost_minor, stock_quantity, remote_status, last_synced_at,
			  enabled, created_at, updated_at)
			 VALUES ('binding', 'item', 'dujiao_next', 'https://supplier.example',
			  '1.3.1-upstream-v1', '1', '2', 'Product', 'SKU', '100', '150',
			  10, 'active', ?, 1, ?, ?)`,
			)
			.bind(now, now, now),
		db
			.prepare(
				`INSERT INTO shop_orders
			 (id, order_number, status, currency, currency_decimals,
			  subtotal_minor, discount_minor, total_minor, paid_minor,
			  expires_at, created_at, updated_at)
			 VALUES ('order', 'ORDER-1', 'pending_payment', 'USD', 2,
			  '0', '0', '0', '0', ?, ?, ?)`,
			)
			.bind(now + 60_000, now, now),
		db
			.prepare(
				`INSERT INTO shop_order_items
			 (id, order_id, product_id, sellable_item_id, product_name,
			  delivery_component_id, delivery_component_type,
			  delivery_component_version, sellable_item_name, quantity,
			  unit_price_minor, discount_minor, subtotal_minor, created_at, updated_at)
			 VALUES ('order-item', 'order', 'product', 'item', 'Product',
			  'item', 'stock', 1, 'SKU', 2, '0', '0', '0', ?, ?)`,
			)
			.bind(now, now),
	]);
}

function upstreamProduct() {
	return {
		id: 1,
		title: { "zh-CN": "商品" },
		description: {},
		images: [],
		tags: [],
		currency: "CNY",
		is_active: true,
		skus: [
			{
				id: 2,
				sku_code: "SKU",
				spec_values: {},
				price_amount: "1.00",
				stock_quantity: 10,
				is_active: true,
			},
		],
	};
}

test("a supplier HTTP 500 on purchase is kept uncertain and never retried on another account", async () => {
	const { db, runtime } = await fixture();
	try {
		const vault = await createSupplierCredentialVault(
			"dujiao_next",
			{ apiKey: "fixture-b", apiSecret: "fixture-only" },
			runtime.commerceSecret,
		);
		await db
			.prepare(
				`INSERT INTO supplier_accounts (id,provider,base_url,normalized_api_origin,protocol_version,currency,currency_decimals,name,credentials_encrypted,credentials_revision,credential_fingerprint,balance_minor,balance_synced_at,enabled,health_status,created_at,updated_at) SELECT 'account-b',provider,base_url,normalized_api_origin,protocol_version,currency,currency_decimals,'B',?,1,'fixture-b','10000',balance_synced_at,1,'healthy',created_at,updated_at FROM supplier_accounts WHERE id='account'`,
			)
			.bind(vault)
			.run();
		await completeFreeStoreOrder(db as any, "order");
		const row = await db.prepare("SELECT id FROM supplier_orders").first<any>();
		let submissions = 0;
		const fetcher = async (input: any) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/ping"))
				return Response.json({
					ok: true,
					site_name: "fixture",
					balance: "100.00",
					currency: "CNY",
				});
			if (path.endsWith("/products/1"))
				return Response.json({ ok: true, product: upstreamProduct() });
			if (path.endsWith("/categories"))
				return Response.json({ ok: true, categories: [] });
			if (path.endsWith("/orders")) {
				submissions++;
				return submissions === 1
					? Response.json({}, { status: 500 })
					: Response.json({ ok: true, order_id: 99, status: "pending" });
			}
			throw new Error("unexpected mock URL");
		};
		await expect(
			processSupplierOrder(db as any, row.id, { fetcher: fetcher as any }),
		).rejects.toMatchObject({ code: "supplier_request_uncertain" });
		const state = await db
			.prepare(
				"SELECT state,selection_count,selected_account_id FROM supplier_orders",
			)
			.first<any>();
		expect(submissions).toBe(1);
		expect(state).toMatchObject({ state: "uncertain", selection_count: 1 });
	} finally {
		db.close();
	}
});
test("a retried API cancellation finishes a refund interrupted after the cancel committed", async () => {
	const { db, runtime } = await fixture();
	try {
		await db
			.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled,balance_minor) VALUES('buyer','Fixture','fixture@example.invalid',1,1,'10000')",
			)
			.run();
		await db
			.prepare(
				"UPDATE product_sellable_items SET fulfillment_source='local',supplier_status=NULL,price_minor='10000' WHERE id='item'",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO supplier_export_listings(id,sellable_item_id,price_minor,currency,currency_decimals,enabled) VALUES('listing','item','10000','USD',2,1)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO supplier_api_keys(id,user_id,name,key_id,secret_encrypted) VALUES('key-row','buyer','fixture','fixture-key','unused-fixture')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO stock_entries(id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status) VALUES('stock','item',?,1,'fixture-fingerprint','fixture','available')",
			)
			.bind(
				await encryptSecret(
					"SYNTHETIC-NOT-A-CARD",
					runtime.commerceSecret,
					"stock-entry",
				),
			)
			.run();
		const created = await createSupplierApiOrder(
			db as any,
			{
				userId: "buyer",
				keyId: "fixture-key",
				keyRowId: "key-row",
				allowedCallbackOrigin: null,
			},
			{ skuId: "item", quantity: 1, downstreamOrderNo: "AUDIT-ONLY" },
		);
		// Inject a process interruption precisely after the cancellation D1 transaction commits.
		const interrupted = {
			prepare: db.prepare.bind(db),
			batch: async (s: any[]) => {
				const result = await db.batch(s);
				if (s[0]?.query?.includes("supplier_api_cancelled"))
					throw new Error("simulated_worker_interruption");
				return result;
			},
		};
		await expect(
			cancelSupplierApiOrder(interrupted as any, "buyer", created.order_id),
		).rejects.toThrow("simulated_worker_interruption");
		const retry = await cancelSupplierApiOrder(
			db as any,
			"buyer",
			created.order_id,
		);
		const state = await db
			.prepare(
				"SELECT balance_minor,(SELECT COUNT(*) FROM wallet_entries WHERE direction='credit') credits FROM users WHERE id='buyer'",
			)
			.first<any>();
		expect(retry.status).toBe("cancelled");
		expect(state.balance_minor).toBe("10000");
		expect(state.credits).toBe(1);
		await cancelSupplierApiOrder(db as any, "buyer", created.order_id);
		const again = await db
			.prepare(
				"SELECT balance_minor,(SELECT COUNT(*) FROM wallet_entries WHERE direction='credit') credits FROM users WHERE id='buyer'",
			)
			.first<any>();
		expect(again).toMatchObject({ balance_minor: "10000", credits: 1 });
	} finally {
		db.close();
	}
});
test("a verified top-up success arriving after expiry is credited exactly once", async () => {
	const { db } = await fixture();
	try {
		await db
			.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled) VALUES('buyer','Fixture','fixture@example.invalid',1,1)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO payment_channels(id,provider,name,currency,enabled) VALUES('channel','gmpay','Fixture','USD',1)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO wallet_topups(id,user_id,amount_minor,currency,currency_decimals,status,idempotency_key) VALUES('topup','buyer','10000','USD',2,'pending','fixture-topup')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO payment_attempts(id,wallet_topup_id,channel_id,provider_payment_id,idempotency_key,status,amount_minor,currency,currency_decimals) VALUES('attempt','topup','channel','fixture-payment','fixture-attempt','pending','10000','USD',2)",
			)
			.run();
		const base = {
			providerPaymentId: "fixture-payment",
			amountMinor: "10000",
			currency: "USD",
		};
		await processShopPaymentEvent(db as any, "channel", {
			...base,
			providerEventId: "expiry",
			type: "payment_expired",
			payloadDigest: "expiry",
		});
		await processShopPaymentEvent(db as any, "channel", {
			...base,
			providerEventId: "late-paid",
			type: "payment_succeeded",
			payloadDigest: "late-paid",
		});
		await processShopPaymentEvent(db as any, "channel", {
			...base,
			providerEventId: "late-paid-2",
			type: "payment_succeeded",
			payloadDigest: "late-paid-2",
		}).catch(() => undefined);
		const state = await db
			.prepare(
				"SELECT status,(SELECT balance_minor FROM users WHERE id='buyer') balance FROM wallet_topups",
			)
			.first<any>();
		expect(state).toMatchObject({ status: "paid", balance: "10000" });
	} finally {
		db.close();
	}
});

test("a queued card email is never sent after the order is fully refunded", async () => {
	const { db, runtime } = await fixture();
	try {
		await db
			.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled,balance_minor) VALUES('buyer','Fixture','fixture@example.invalid',1,1,'10000')",
			)
			.run();
		await db
			.prepare(
				"UPDATE product_sellable_items SET fulfillment_source='local',supplier_status=NULL,price_minor='10000' WHERE id='item'",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO supplier_export_listings(id,sellable_item_id,price_minor,currency,currency_decimals,enabled) VALUES('listing','item','10000','USD',2,1)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO supplier_api_keys(id,user_id,name,key_id,secret_encrypted) VALUES('key-row','buyer','fixture','fixture-key','unused-fixture')",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO stock_entries(id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status) VALUES('stock','item',?,1,'fixture-fingerprint','fixture','available')",
			)
			.bind(
				await encryptSecret(
					"SYNTHETIC-NOT-A-CARD",
					runtime.commerceSecret,
					"stock-entry",
				),
			)
			.run();
		const created = await createSupplierApiOrder(
			db as any,
			{
				userId: "buyer",
				keyId: "fixture-key",
				keyRowId: "key-row",
				allowedCallbackOrigin: null,
			},
			{ skuId: "item", quantity: 1, downstreamOrderNo: "AUDIT-ONLY" },
		);

		const { processDelivery } = await import(
			"#/features/fulfillment/server/process"
		);
		const { requestShopRefund } = await import(
			"#/features/shop-payments/server/refunds"
		);
		const { enqueueEmailNotification, processEmailNotification } = await import(
			"#/features/notifications/server/delivery"
		);
		const ids = await db
			.prepare(
				"SELECT api.shop_order_id,dr.id delivery_id,g.entitlement_id FROM supplier_api_orders api JOIN shop_order_items i ON i.order_id=api.shop_order_id JOIN delivery_records dr ON dr.order_item_id=i.id JOIN entitlement_grants g ON g.source_order_item_id=i.id WHERE api.id=?",
			)
			.bind(created.order_id)
			.first<any>();
		await processDelivery(db as any, ids.delivery_id);
		await db
			.prepare(
				"INSERT INTO notification_channel_configs(id,channel,provider,name,from_address,enabled) VALUES('email','email','cloudflare_email','Fixture','noreply@audit.local',1)",
			)
			.run();
		const queued = await enqueueEmailNotification(db as any, {
			event: "delivery_ready",
			idempotencyKey: "fixture-message",
			message: {
				to: "fixture@audit.local",
				from: "noreply@audit.local",
				replyTo: "",
				subject: "Fixture",
				text: "SYNTHETIC-NOT-A-CARD",
				html: "",
			},
			asset: {
				entitlementId: ids.entitlement_id,
				assetType: "stock_secret",
				assetId: ids.delivery_id,
				accessEventType: "email_content_sent",
			},
		});
		await requestShopRefund(
			db as any,
			{
				orderId: ids.shop_order_id,
				amountMinor: "10000",
				reason: "fixture full refund",
				idempotencyKey: "fixture-full-refund",
			},
			{
				actorUserId: "buyer",
				request: new Request("https://audit.example/admin"),
			},
		);
		let sends = 0;
		let carriesCard = false;
		let errorCode = null;
		try {
			await processEmailNotification(db as any, queued.id, {
				cloudflareEmail: {
					send: async (message: any) => {
						sends++;
						carriesCard = message.text === "SYNTHETIC-NOT-A-CARD";
						return { messageId: "mock-only" };
					},
				} as any,
			});
		} catch (e: any) {
			errorCode = e.code;
		}
		const order = await db
			.prepare("SELECT status FROM shop_orders WHERE id=?")
			.bind(ids.shop_order_id)
			.first<any>();
		expect(order.status).toBe("refunded");
		expect(sends).toBe(0);
		expect(carriesCard).toBe(false);
		expect(errorCode).toBeNull();
		const note = await db
			.prepare(
				"SELECT status,error_code FROM notification_deliveries WHERE id=?",
			)
			.bind(queued.id)
			.first<any>();
		expect(note).toMatchObject({
			status: "suppressed",
			error_code: "order_refunded",
		});
	} finally {
		db.close();
	}
});

// --- Follow-up regressions from the fix review ---------------------------

async function queuedCardEmail(db: any, runtime: any, deliver = true) {
	await db
		.prepare(
			"INSERT INTO users(id,name,email,email_verified,enabled,balance_minor) VALUES('buyer','Fixture','fixture@example.invalid',1,1,'10000')",
		)
		.run();
	await db
		.prepare(
			"UPDATE product_sellable_items SET fulfillment_source='local',supplier_status=NULL,price_minor='10000' WHERE id='item'",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO supplier_export_listings(id,sellable_item_id,price_minor,currency,currency_decimals,enabled) VALUES('listing','item','10000','USD',2,1)",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO supplier_api_keys(id,user_id,name,key_id,secret_encrypted) VALUES('key-row','buyer','fixture','fixture-key','unused-fixture')",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO stock_entries(id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status) VALUES('stock','item',?,1,'fixture-fingerprint','fixture','available')",
		)
		.bind(
			await encryptSecret(
				"SYNTHETIC-NOT-A-CARD",
				runtime.commerceSecret,
				"stock-entry",
			),
		)
		.run();
	const created = await createSupplierApiOrder(
		db,
		{
			userId: "buyer",
			keyId: "fixture-key",
			keyRowId: "key-row",
			allowedCallbackOrigin: null,
		},
		{ skuId: "item", quantity: 1, downstreamOrderNo: "AUDIT-FOLLOWUP" },
	);
	const { processDelivery } = await import(
		"#/features/fulfillment/server/process"
	);
	const { enqueueEmailNotification, processEmailNotification } = await import(
		"#/features/notifications/server/delivery"
	);
	const ids = await db
		.prepare(
			"SELECT api.shop_order_id,i.id order_item_id,dr.id delivery_id,g.entitlement_id FROM supplier_api_orders api JOIN shop_order_items i ON i.order_id=api.shop_order_id JOIN delivery_records dr ON dr.order_item_id=i.id JOIN entitlement_grants g ON g.source_order_item_id=i.id WHERE api.id=?",
		)
		.bind(created.order_id)
		.first();
	if (!deliver)
		return {
			created,
			ids,
			queued: null as any,
			send: null as any,
			sends: () => 0,
		};
	await processDelivery(db, ids.delivery_id);
	await db
		.prepare(
			"INSERT INTO notification_channel_configs(id,channel,provider,name,from_address,enabled) VALUES('email','email','cloudflare_email','Fixture','noreply@audit.local',1)",
		)
		.run();
	const queued = await enqueueEmailNotification(db, {
		event: "delivery_ready",
		idempotencyKey: "fixture-followup",
		message: {
			to: "fixture@audit.local",
			from: "noreply@audit.local",
			replyTo: "",
			subject: "Fixture",
			text: "SYNTHETIC-NOT-A-CARD",
			html: "",
		},
		asset: {
			entitlementId: ids.entitlement_id,
			assetType: "stock_secret",
			assetId: ids.delivery_id,
			accessEventType: "email_content_sent",
		},
	});
	let sends = 0;
	const send = (target: any = db) =>
		processEmailNotification(target, queued.id, {
			cloudflareEmail: {
				send: async () => {
					sends += 1;
					return { messageId: "mock-only" };
				},
			} as any,
		});
	return { created, ids, queued, send, sends: () => sends };
}

test("a renewal's email is judged by its own order line, not the shared entitlement's first order", async () => {
	const { db, runtime } = await fixture();
	try {
		const email = await queuedCardEmail(db, runtime);
		// The shared entitlement now points at an earlier, refunded order line.
		await db.batch([
			db.prepare(
				"INSERT INTO shop_orders(id,order_number,status,currency,currency_decimals,subtotal_minor,discount_minor,total_minor,paid_minor,expires_at,created_at,updated_at) VALUES('old-order','OLD-1','refunded','USD',2,'0','0','0','0',1,1,1)",
			),
			db.prepare(
				"INSERT INTO shop_order_items(id,order_id,product_id,sellable_item_id,product_name,delivery_component_id,delivery_component_type,delivery_component_version,sellable_item_name,quantity,unit_price_minor,discount_minor,subtotal_minor,created_at,updated_at) VALUES('old-item','old-order','product','item','Product','item','stock',1,'SKU',1,'0','0','0',1,1)",
			),
			db
				.prepare(
					"UPDATE customer_entitlements SET order_item_id='old-item' WHERE id=?",
				)
				.bind(email.ids.entitlement_id),
		]);
		await email.send();
		expect(email.sends()).toBe(1);
	} finally {
		db.close();
	}
});

test("a refunded renewal's email is suppressed even while the shared entitlement stays active", async () => {
	const { db, runtime } = await fixture();
	try {
		const email = await queuedCardEmail(db, runtime);
		await db.batch([
			db
				.prepare("UPDATE shop_orders SET status='refunded' WHERE id=?")
				.bind(email.ids.shop_order_id),
			db
				.prepare(
					"UPDATE entitlement_grants SET status='refunded' WHERE source_order_item_id=?",
				)
				.bind(email.ids.order_item_id),
			db
				.prepare("UPDATE customer_entitlements SET status='active' WHERE id=?")
				.bind(email.ids.entitlement_id),
		]);
		expect(await email.send()).toMatchObject({ status: "suppressed" });
		expect(email.sends()).toBe(0);
	} finally {
		db.close();
	}
});

test("an email held during a refund is rescheduled without burning queue retries, then sent once the refund settles", async () => {
	const { db, runtime } = await fixture();
	try {
		const email = await queuedCardEmail(db, runtime);
		await db
			.prepare("UPDATE shop_orders SET status='refunding' WHERE id=?")
			.bind(email.ids.shop_order_id)
			.run();
		expect(await email.send()).toMatchObject({ status: "deferred" });
		expect(email.sends()).toBe(0);
		const held = await db
			.prepare(
				"SELECT status,error_code,next_attempt_at FROM notification_deliveries WHERE id=?",
			)
			.bind(email.queued.id)
			.first<any>();
		expect(held).toMatchObject({
			status: "pending",
			error_code: "order_refunding",
		});
		const wake = await db
			.prepare(
				"SELECT COUNT(*) n FROM outbox_events WHERE event_type='notification.requested' AND aggregate_id=? AND status='pending' AND next_attempt_at=?",
			)
			.bind(email.queued.id, held.next_attempt_at)
			.first<any>();
		expect(wake.n).toBe(1);
		// The partial refund settles; the order is back to completed.
		await db.batch([
			db
				.prepare("UPDATE shop_orders SET status='completed' WHERE id=?")
				.bind(email.ids.shop_order_id),
			db
				.prepare(
					"UPDATE notification_deliveries SET next_attempt_at=? WHERE id=?",
				)
				.bind(Date.now() - 1, email.queued.id),
		]);
		expect(await email.send()).toMatchObject({ status: "accepted" });
		expect(email.sends()).toBe(1);
	} finally {
		db.close();
	}
});

test("a refund completing after the send was claimed still stops the email", async () => {
	const { db, runtime } = await fixture();
	try {
		const email = await queuedCardEmail(db, runtime);
		const racing = {
			batch: db.batch.bind(db),
			prepare(sql: string) {
				const statement = db.prepare(sql);
				if (!sql.includes("SET status = 'sending'")) return statement;
				return {
					bind: (...values: unknown[]) => {
						const bound = statement.bind(...values);
						return {
							run: async () => {
								const result = await bound.run();
								await db
									.prepare(
										"UPDATE shop_orders SET status='refunded' WHERE id=?",
									)
									.bind(email.ids.shop_order_id)
									.run();
								return result;
							},
						};
					},
				};
			},
		};
		expect(await email.send(racing)).toMatchObject({ status: "suppressed" });
		expect(email.sends()).toBe(0);
	} finally {
		db.close();
	}
});

test("cancelling an API order after a partial wallet refund returns only the rest", async () => {
	const { db, runtime } = await fixture();
	try {
		const email = await queuedCardEmail(db, runtime, false);
		// Still undelivered, so cancellable; record an earlier partial refund of
		// 2000 for it.
		await db.batch([
			db
				.prepare(
					"INSERT INTO wallet_entries(id,user_id,direction,amount_minor,balance_before_minor,balance_after_minor,currency,source_type,source_id,idempotency_key,created_at) VALUES('partial','buyer','credit','2000','0','2000','USD','refund',?,'wallet-refund:partial',1)",
				)
				.bind(email.ids.shop_order_id),
			db.prepare("UPDATE users SET balance_minor='2000' WHERE id='buyer'"),
		]);
		await cancelSupplierApiOrder(db as any, "buyer", email.created.order_id);
		const wallet = await db
			.prepare(
				"SELECT balance_minor,(SELECT SUM(CAST(amount_minor AS INTEGER)) FROM wallet_entries WHERE direction='credit') credited FROM users WHERE id='buyer'",
			)
			.first<any>();
		expect(wallet).toMatchObject({ balance_minor: "10000", credited: 10000 });
	} finally {
		db.close();
	}
});
