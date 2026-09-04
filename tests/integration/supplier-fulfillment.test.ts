import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeFreeStoreOrder } from "#/features/shop-payments/server/service";
import { supplierFetchJson } from "#/features/suppliers/providers/http";
import { signDujiaoNextRequest } from "#/features/suppliers/providers/signatures";
import { createSupplierCredentialVault } from "#/features/suppliers/secrets";
import { createSupplierHttpAudit } from "#/features/suppliers/server/diagnostics";
import { handleDujiaoSupplierCallback } from "#/features/suppliers/server/dujiao-callback";
import { processSupplierOrder } from "#/features/suppliers/server/process";
import { decryptSecret } from "#/lib/secrets";
import {
	createInitialRuntimeConfig,
	runtimeConfigEntries,
} from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

describe("supplier fulfillment", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	const runtime = createInitialRuntimeConfig("https://shop.example");

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
			r2Buckets: { FILES: "files" },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seed(db, runtime);
	});

	afterEach(async () => miniflare.dispose());

	it("enforces the three-table account grouping and credential revision constraints", async () => {
		const tables = await db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name LIKE 'supplier_%' ORDER BY name`,
			)
			.all<{ name: string }>();
		expect(tables.results).toEqual([
			{ name: "supplier_accounts" },
			{ name: "supplier_api_keys" },
			{ name: "supplier_api_orders" },
			{ name: "supplier_bindings" },
			{ name: "supplier_exchange_records" },
			{ name: "supplier_export_listings" },
			{ name: "supplier_orders" },
		]);
		await expect(
			db
				.prepare(
					"UPDATE supplier_accounts SET credentials_revision = 0 WHERE id = 'account'",
				)
				.run(),
		).rejects.toThrow(/supplier_accounts_credentials_revision_check/);
		await expect(
			db
				.prepare(
					`INSERT INTO supplier_accounts
					 (id, provider, base_url, normalized_api_origin, protocol_version,
					  currency, currency_decimals, name, credentials_encrypted,
					  credentials_revision, credential_fingerprint, enabled,
					  health_status, created_at, updated_at)
					 SELECT 'duplicate-name', provider, base_url, normalized_api_origin,
					  protocol_version, currency, currency_decimals, name,
					  credentials_encrypted, 1, 'another-fingerprint', enabled,
					  health_status, created_at, updated_at
					 FROM supplier_accounts WHERE id = 'account'`,
				)
				.run(),
		).rejects.toThrow(/UNIQUE constraint failed/);
	});

	it("atomically creates an awaiting supplier order after payment", async () => {
		await expect(completeFreeStoreOrder(db, "order")).resolves.toMatchObject({
			status: "paid",
		});
		const state = await db
			.prepare(
				`SELECT so.state, so.quantity, so.binding_snapshot_json,
				        dr.status AS delivery_status, oe.event_type, oe.payload
				 FROM supplier_orders so
				 JOIN delivery_records dr ON dr.id = so.delivery_record_id
				 JOIN outbox_events oe ON oe.aggregate_id = so.id
				 WHERE so.order_id = 'order'`,
			)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({
			state: "pending",
			quantity: 2,
			delivery_status: "awaiting_supply",
			event_type: "supplier.requested",
		});
		expect(JSON.parse(String(state?.payload))).toEqual({
			supplierOrderId: expect.any(String),
		});
	});

	it("locks a processing account, then imports encrypted cards idempotently", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		expect(supplierOrder).toBeTruthy();
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(
				typeof input === "string"
					? input
					: input instanceof URL
						? input
						: input.url,
			);
			if (url.pathname === "/api/v1/upstream/ping")
				return Response.json({
					ok: true,
					site_name: "Supplier",
					balance: "100.00",
					currency: "CNY",
				});
			if (url.pathname === "/api/v1/upstream/products/1")
				return Response.json({ ok: true, product: upstreamProduct() });
			if (url.pathname === "/api/v1/upstream/categories")
				return Response.json({ ok: true, categories: [] });
			if (url.pathname === "/api/v1/upstream/orders")
				return Response.json({ ok: true, order_id: 99, status: "pending" });
			if (url.pathname === "/api/v1/upstream/orders/99")
				return Response.json({
					order_id: 99,
					status: "completed",
					fulfillment: {
						status: "delivered",
						payload: "CARD-1\nCARD-2",
					},
				});
			throw new Error(`Unexpected URL ${url}`);
		};
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		const locked = await db
			.prepare(
				`SELECT state, selected_account_id, selected_credentials_revision,
				        provider_request_no, upstream_order_id, account_locked_at
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(locked).toMatchObject({
			state: "uncertain",
			selected_account_id: "account",
			selected_credentials_revision: 1,
			upstream_order_id: "99",
		});
		expect(locked?.provider_request_no).toMatch(/^gm_[a-f0-9]{40}$/);
		expect(locked?.account_locked_at).toEqual(expect.any(Number));

		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).resolves.toMatchObject({ state: "supplied", duplicate: false });
		const fulfilled = await db
			.prepare(
				`SELECT so.state, dr.status AS delivery_status,
				        (SELECT COUNT(*) FROM stock_entries se
				         WHERE se.supplier_order_id = so.id AND se.status = 'reserved') AS cards,
				        (SELECT COUNT(*) FROM outbox_events oe
				         WHERE oe.idempotency_key = 'supplier-delivery-requested:' || dr.id) AS delivery_events
				 FROM supplier_orders so
				 JOIN delivery_records dr ON dr.id = so.delivery_record_id
				 WHERE so.id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(fulfilled).toMatchObject({
			state: "supplied",
			delivery_status: "pending",
			cards: 2,
			delivery_events: 1,
		});
		await expect(
			db.prepare("DELETE FROM supplier_accounts WHERE id = 'account'").run(),
		).rejects.toThrow(/FOREIGN KEY constraint failed/);
	});

	it.each([
		"non-json",
		"invalid-card",
		"quantity-mismatch",
	])("retains a SharedStock submission after %s without buying again", async (failure) => {
		const files = await miniflare.getR2Bucket("FILES");
		const vault = await createSupplierCredentialVault(
			"shared_stock",
			{ appId: "merchant", appKey: "test-secret" },
			runtime.commerceSecret,
		);
		await db.batch([
			db
				.prepare(`UPDATE supplier_accounts SET provider = 'shared_stock',
			 protocol_version = 'acg-sharedstock-v1', credentials_encrypted = ? WHERE id = 'account'`)
				.bind(vault),
			db.prepare(`UPDATE supplier_bindings SET provider = 'shared_stock',
			 protocol_version = 'acg-sharedstock-v1', upstream_product_id = 'PLUS',
			 upstream_sku_id = 'PLUS'`),
		]);
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		const requests: string[] = [];
		const submittedRequestNumbers: Array<string | null> = [];
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			requests.push(path);
			if (path.endsWith("/connect"))
				return Response.json({
					code: 200,
					data: { shopName: "Supplier", balance: "100.00" },
				});
			if (path.endsWith("/inventory"))
				return Response.json({
					code: 200,
					data: { count: 10, delivery_way: 0, price: "1.00" },
				});
			if (path.endsWith("/trade")) {
				submittedRequestNumbers.push(
					new URLSearchParams(await request.text()).get("request_no"),
				);
				if (failure === "non-json")
					return new Response("<html>upstream error</html>", { status: 502 });
				return Response.json({
					code: 200,
					data: {
						tradeNo: "trade-123",
						secret:
							failure === "invalid-card" ? "X".repeat(65_000) : "ONE-CARD",
					},
				});
			}
			if (path.endsWith("/query"))
				return Response.json({
					code: 200,
					data: { secret: "CARD-1\nCARD-2", status: 1 },
				});
			throw new Error("Unexpected request");
		};
		await expect(
			processSupplierOrder(db, order?.id ?? "", { fetcher, files }),
		).rejects.toMatchObject({
			code:
				failure === "quantity-mismatch"
					? "supplier_delivery_quantity_mismatch"
					: "supplier_order_pending",
		});
		const first = await db
			.prepare(`SELECT state, selected_account_id, provider_request_no,
		 attempt_count, next_retry_at, account_locked_at, upstream_order_id, last_error_code FROM supplier_orders WHERE id = ?`)
			.bind(order?.id)
			.first();
		expect(first).toMatchObject({
			state: "uncertain",
			selected_account_id: "account",
			attempt_count: 1,
			provider_request_no: expect.stringMatching(/^[a-f0-9]{19}$/),
			account_locked_at: expect.any(Number),
			next_retry_at: expect.any(Number),
			upstream_order_id: failure === "non-json" ? null : "trade-123",
			last_error_code:
				failure === "quantity-mismatch"
					? "supplier_delivery_quantity_mismatch"
					: "invalid_supplier_response",
		});
		if (failure === "non-json") {
			await expect(
				processSupplierOrder(db, order?.id ?? "", { fetcher, files }),
			).rejects.toMatchObject({ code: "supplier_request_uncertain" });
		} else {
			await expect(
				processSupplierOrder(db, order?.id ?? "", { fetcher, files }),
			).resolves.toMatchObject({ state: "supplied" });
			expect(requests.filter((path) => path.endsWith("/query"))).toHaveLength(
				1,
			);
		}
		expect(requests.filter((path) => path.endsWith("/trade"))).toHaveLength(1);
		expect(submittedRequestNumbers).toEqual([first?.provider_request_no]);
		expect(submittedRequestNumbers[0]).toHaveLength(19);
		expect(
			await db
				.prepare(
					"SELECT state, provider_request_no, attempt_count FROM supplier_orders WHERE id = ?",
				)
				.bind(order?.id)
				.first(),
		).toMatchObject({
			state: failure === "non-json" ? "uncertain" : "supplied",
			provider_request_no: first?.provider_request_no,
			attempt_count: 1,
		});
		const exchanges = await db
			.prepare(
				"SELECT * FROM supplier_exchange_records WHERE supplier_order_id = ? ORDER BY started_at, id",
			)
			.bind(order?.id)
			.all<{ object_key: string; status: string; error_code: string | null }>();
		expect(exchanges.results).toHaveLength(failure === "non-json" ? 3 : 4);
		expect(
			JSON.stringify(
				await db
					.prepare(
						"EXPLAIN QUERY PLAN SELECT * FROM supplier_exchange_records WHERE supplier_order_id = ? ORDER BY started_at, id",
					)
					.bind(order?.id)
					.all(),
			),
		).toContain("supplier_exchange_order_idx");
		for (const exchange of exchanges.results) {
			expect(exchange.status).toBe("recorded");
			const encrypted = await (await files.get(exchange.object_key))?.text();
			expect(encrypted).toBeTruthy();
			expect(encrypted).not.toContain("CARD-");
			const evidence = JSON.parse(
				await decryptSecret(
					encrypted ?? "",
					runtime.commerceSecret,
					"supplier-diagnostic",
				),
			);
			expect(JSON.stringify(evidence)).not.toContain("test-secret");
			expect(evidence.request.body).not.toContain('"merchant"');
			if (evidence.request.url.endsWith("/trade")) {
				expect(evidence.response.httpStatus).toBe(
					failure === "non-json" ? 502 : 200,
				);
				expect(evidence.response.truncated).toBe(false);
				expect(evidence.response.body).toContain(
					failure === "non-json" ? "upstream error" : "trade-123",
				);
			}
		}
	});

	it("fails closed before HTTP if durable request logging is unavailable", async () => {
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		const fetcher = vi.fn<typeof fetch>();
		const audit = createSupplierHttpAudit({
			db,
			files: {
				put: async () => {
					throw new Error("storage unavailable");
				},
			},
			supplierOrderId: order?.id ?? "",
			accountId: "account",
			commerceSecret: runtime.commerceSecret,
			credentialValues: [],
		});
		await expect(
			supplierFetchJson(
				fetcher,
				"https://supplier.example/trade",
				{ method: "POST", body: "{}" },
				{ validateDestination: false, audit },
			),
		).rejects.toMatchObject({ code: "supplier_diagnostics_unavailable" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("retains a durable marker and quarantines a post-request recording failure", async () => {
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		const files = await miniflare.getR2Bucket("FILES");
		const put = vi
			.fn(files.put.bind(files))
			.mockImplementationOnce(files.put.bind(files))
			.mockRejectedValue(new Error("storage unavailable"));
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({ code: 200, data: { secret: "PRIVATE-CDK" } }),
		);
		const audit = createSupplierHttpAudit({
			db,
			files: { put },
			supplierOrderId: order?.id ?? "",
			accountId: "account",
			commerceSecret: runtime.commerceSecret,
			credentialValues: [],
		});
		await expect(
			supplierFetchJson(
				fetcher,
				"https://supplier.example/trade",
				{ method: "POST", body: "{}" },
				{ validateDestination: false, audit },
			),
		).rejects.toMatchObject({ code: "supplier_request_uncertain" });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(
			await db
				.prepare(
					"SELECT status, error_code FROM supplier_exchange_records WHERE supplier_order_id = ?",
				)
				.bind(order?.id)
				.first(),
		).toEqual({
			status: "recording_failed",
			error_code: "diagnostics_persist_failed",
		});
	});

	it("also retains another provider's account after a malformed purchase response", async () => {
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		let submitted = 0;
		const fetcher: typeof fetch = async (input, init) => {
			if (
				new URL(new Request(input, init).url).pathname ===
				"/api/v1/upstream/orders"
			) {
				submitted++;
				return new Response("<html>failure</html>");
			}
			return pendingSupplierFetcher(input, init);
		};
		await expect(
			processSupplierOrder(db, order?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "invalid_supplier_response" });
		expect(
			await db
				.prepare(
					"SELECT state, selected_account_id, last_error_code FROM supplier_orders WHERE id = ?",
				)
				.bind(order?.id)
				.first(),
		).toEqual({
			state: "uncertain",
			selected_account_id: "account",
			last_error_code: "invalid_supplier_response",
		});
		await expect(
			processSupplierOrder(db, order?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		expect(submitted).toBe(1);
	});

	it("removes credentials while retaining encrypted fulfillment evidence", async () => {
		await completeFreeStoreOrder(db, "order");
		const order = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		const files = await miniflare.getR2Bucket("FILES");
		const record = await createSupplierHttpAudit({
			db,
			files,
			supplierOrderId: order?.id ?? "",
			accountId: "account",
			commerceSecret: runtime.commerceSecret,
			credentialValues: ["DO-NOT-LOG-API-KEY"],
		})({
			url: "https://supplier.example/query?token=QUERY-TOKEN",
			init: {
				method: "POST",
				headers: {
					Authorization: "Bearer DO-NOT-LOG-API-KEY",
					Cookie: "COOKIE-VALUE",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					api_key: "DO-NOT-LOG-API-KEY",
					password: "EXAMPLE-PASSWORD",
					quantity: 1,
				}),
			},
		});
		const body = new TextEncoder().encode(
			JSON.stringify({
				secret: "FULFILLMENT-CARD",
				reflected: "DO-NOT-LOG-API-KEY",
				token: "REFLECTED-TOKEN",
			}),
		);
		await record({
			status: 200,
			headers: new Headers({
				"content-type": "application/json",
				"set-cookie": "NEW-COOKIE",
			}),
			body,
			bodyBytes: body.length,
			truncated: false,
			errorCode: null,
		});
		const row = await db
			.prepare(
				"SELECT object_key FROM supplier_exchange_records WHERE supplier_order_id = ?",
			)
			.bind(order?.id)
			.first<{ object_key: string }>();
		const encrypted = await (await files.get(row?.object_key ?? ""))?.text();
		const clear = await decryptSecret(
			encrypted ?? "",
			runtime.commerceSecret,
			"supplier-diagnostic",
		);
		for (const secret of [
			"DO-NOT-LOG-API-KEY",
			"QUERY-TOKEN",
			"COOKIE-VALUE",
			"NEW-COOKIE",
			"EXAMPLE-PASSWORD",
			"REFLECTED-TOKEN",
		])
			expect(clear).not.toContain(secret);
		expect(clear).toContain("FULFILLMENT-CARD");
		expect(encrypted).not.toContain("FULFILLMENT-CARD");
	});

	it("switches only after a definitive rejection and keeps the source fixed", async () => {
		const secondVault = await createSupplierCredentialVault(
			"dujiao_next",
			{ apiKey: "api-key-b", apiSecret: "api-secret-b" },
			runtime.commerceSecret,
		);
		await db
			.prepare(
				`INSERT INTO supplier_accounts
				 (id, provider, base_url, normalized_api_origin, protocol_version,
				  currency, currency_decimals, name, credentials_encrypted,
				  credentials_revision, credential_fingerprint, balance_minor,
				  balance_synced_at, enabled, health_status, created_at, updated_at)
				 VALUES ('account-b', 'dujiao_next', 'https://supplier.example',
				  'https://supplier.example', '1.3.1-upstream-v1', 'CNY', 2,
				  'Account B', ?, 1, 'fingerprint-b', '10000', ?, 1, 'healthy', ?, ?)`,
			)
			.bind(secondVault, Date.now(), Date.now(), Date.now())
			.run();
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		const submittedBy: string[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			const apiKey = request.headers.get("Dujiao-Next-Api-Key") ?? "";
			if (url.pathname === "/api/v1/upstream/ping")
				return Response.json({
					ok: true,
					site_name: apiKey,
					balance: "100.00",
					currency: "CNY",
				});
			if (url.pathname === "/api/v1/upstream/products/1")
				return Response.json({ ok: true, product: upstreamProduct() });
			if (url.pathname === "/api/v1/upstream/categories")
				return Response.json({ ok: true, categories: [] });
			if (url.pathname === "/api/v1/upstream/orders") {
				submittedBy.push(apiKey);
				return apiKey === "api-key"
					? Response.json({
							ok: false,
							error_code: "insufficient_balance",
						})
					: Response.json({ ok: true, order_id: 199, status: "pending" });
			}
			throw new Error(`Unexpected URL ${url}`);
		};

		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		expect(submittedBy).toEqual(["api-key", "api-key-b"]);
		const state = await db
			.prepare(
				`SELECT selected_account_id, upstream_order_id, selection_count, state,
				 (SELECT normalized_api_origin FROM supplier_accounts
				  WHERE id = selected_account_id) AS selected_origin
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(state).toMatchObject({
			selected_account_id: "account-b",
			upstream_order_id: "199",
			selection_count: 2,
			state: "uncertain",
			selected_origin: "https://supplier.example",
		});
	});

	it("rejects duplicate or wrong-count fulfillment without storing cards", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		let reconciliation = false;
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(String(input));
			if (url.pathname === "/api/v1/upstream/ping")
				return Response.json({
					ok: true,
					site_name: "Supplier",
					balance: "100.00",
					currency: "CNY",
				});
			if (url.pathname === "/api/v1/upstream/products/1")
				return Response.json({ ok: true, product: upstreamProduct() });
			if (url.pathname === "/api/v1/upstream/categories")
				return Response.json({ ok: true, categories: [] });
			if (url.pathname === "/api/v1/upstream/orders")
				return Response.json({ ok: true, order_id: 299, status: "pending" });
			if (url.pathname === "/api/v1/upstream/orders/299") {
				reconciliation = true;
				return Response.json({
					order_id: 299,
					status: "completed",
					fulfillment: {
						status: "delivered",
						payload: "DUPLICATE\nDUPLICATE",
					},
				});
			}
			throw new Error(`Unexpected URL ${url}`);
		};
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		).rejects.toMatchObject({ code: "supplier_delivery_quantity_mismatch" });
		expect(reconciliation).toBe(true);
		const state = await db
			.prepare(
				`SELECT state,
				 (SELECT COUNT(*) FROM stock_entries WHERE supplier_order_id = ?) AS cards
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id, supplierOrder?.id)
			.first();
		expect(state).toMatchObject({ state: "uncertain", cards: 0 });
	});

	it("deduplicates concurrent queue consumers before upstream submission", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		let submissions = 0;
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			if (
				request.method === "POST" &&
				new URL(request.url).pathname === "/api/v1/upstream/orders"
			)
				submissions += 1;
			return pendingSupplierFetcher(input, init);
		};
		await Promise.allSettled([
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
			processSupplierOrder(db, supplierOrder?.id ?? "", { fetcher }),
		]);
		expect(submissions).toBe(1);
		const state = await db
			.prepare(
				`SELECT state, attempt_count, selection_count,
				 (SELECT COUNT(*) FROM supplier_orders WHERE order_id = 'order') AS orders
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(state).toMatchObject({
			state: "uncertain",
			attempt_count: 1,
			selection_count: 1,
			orders: 1,
		});
	});

	it("stores one card set under concurrent distinct fulfillment callbacks", async () => {
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", {
				fetcher: pendingSupplierFetcher,
			}),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		const locked = await db
			.prepare("SELECT provider_request_no FROM supplier_orders WHERE id = ?")
			.bind(supplierOrder?.id)
			.first<{ provider_request_no: string }>();
		const timestamp = 1_800_000_000;
		const callback = (event: string, cards: string) => {
			const rawBody = JSON.stringify({
				event,
				order_id: 99,
				order_no: "UPSTREAM-99",
				downstream_order_no: locked?.provider_request_no,
				status: "completed",
				fulfillment: {
					type: "auto",
					status: "delivered",
					payload: cards,
				},
				timestamp,
			});
			return new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": signDujiaoNextRequest({
							method: "POST",
							path: "/api/v1/upstream/callback",
							timestamp: String(timestamp),
							rawBody,
							apiSecret: "api-secret",
						}),
					},
					body: rawBody,
				},
			);
		};
		const responses = await Promise.all([
			handleDujiaoSupplierCallback(
				callback("order.fulfilled.primary", "PRIMARY-1\nPRIMARY-2"),
				"account",
				db,
				timestamp * 1000,
			),
			handleDujiaoSupplierCallback(
				callback("order.fulfilled.variant", "VARIANT-1\nVARIANT-2"),
				"account",
				db,
				timestamp * 1000,
			),
		]);
		for (const response of responses)
			await expect(response.json()).resolves.toMatchObject({ ok: true });
		const state = await db
			.prepare(
				`SELECT state,
				 (SELECT COUNT(*) FROM stock_entries WHERE supplier_order_id = ?) AS cards,
				 (SELECT COUNT(*) FROM outbox_events
				  WHERE idempotency_key = 'supplier-delivery-requested:' || delivery_record_id) AS events
				 FROM supplier_orders WHERE id = ?`,
			)
			.bind(supplierOrder?.id, supplierOrder?.id)
			.first<Record<string, unknown>>();
		expect(state).toMatchObject({ state: "supplied", cards: 2, events: 1 });
	});

	it("verifies and deduplicates a signed Dujiao Next fulfillment callback", async () => {
		const files = await miniflare.getR2Bucket("FILES");
		await completeFreeStoreOrder(db, "order");
		const supplierOrder = await db
			.prepare("SELECT id FROM supplier_orders WHERE order_id = 'order'")
			.first<{ id: string }>();
		await expect(
			processSupplierOrder(db, supplierOrder?.id ?? "", {
				fetcher: pendingSupplierFetcher,
			}),
		).rejects.toMatchObject({ code: "supplier_order_pending" });
		const locked = await db
			.prepare("SELECT provider_request_no FROM supplier_orders WHERE id = ?")
			.bind(supplierOrder?.id)
			.first<{ provider_request_no: string }>();
		const timestamp = 1_800_000_000;
		const payload = {
			event: "order.fulfilled",
			order_id: 99,
			order_no: "UPSTREAM-99",
			downstream_order_no: locked?.provider_request_no,
			status: "completed",
			fulfillment: {
				type: "auto",
				status: "delivered",
				payload: "CALLBACK-1\nCALLBACK-2",
			},
			timestamp,
		};
		const rawBody = JSON.stringify(payload);
		const signature = signDujiaoNextRequest({
			method: "POST",
			path: "/api/v1/upstream/callback",
			timestamp: String(timestamp),
			rawBody,
			apiSecret: "api-secret",
		});
		const request = () =>
			new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": signature,
					},
					body: rawBody,
				},
			);
		const first = await handleDujiaoSupplierCallback(
			request(),
			"account",
			db,
			timestamp * 1000,
			files,
		);
		const duplicate = await handleDujiaoSupplierCallback(
			request(),
			"account",
			db,
			timestamp * 1000,
			files,
		);
		await expect(first.json()).resolves.toMatchObject({ ok: true });
		await expect(duplicate.json()).resolves.toMatchObject({ ok: true });
		const invalidSignature = await handleDujiaoSupplierCallback(
			new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": "0".repeat(64),
					},
					body: rawBody,
				},
			),
			"account",
			db,
			timestamp * 1000,
			files,
		);
		await expect(invalidSignature.json()).resolves.toEqual({
			ok: false,
			message: "authentication_failed",
		});
		const latePayload = { ...payload, event: "order.fulfilled.late" };
		const lateRawBody = JSON.stringify(latePayload);
		const lateSignature = signDujiaoNextRequest({
			method: "POST",
			path: "/api/v1/upstream/callback",
			timestamp: String(timestamp),
			rawBody: lateRawBody,
			apiSecret: "api-secret",
		});
		const late = await handleDujiaoSupplierCallback(
			new Request(
				"https://shop.example/api/suppliers/dujiao-next/callback/account",
				{
					method: "POST",
					headers: {
						"Dujiao-Next-Api-Key": "api-key",
						"Dujiao-Next-Timestamp": String(timestamp),
						"Dujiao-Next-Signature": lateSignature,
					},
					body: lateRawBody,
				},
			),
			"account",
			db,
			timestamp * 1000,
			files,
		);
		await expect(late.json()).resolves.toMatchObject({ ok: true });
		const state = await db
			.prepare(
				`SELECT so.state,
				        (SELECT COUNT(*) FROM stock_entries se
				         WHERE se.supplier_order_id = so.id) AS cards,
				        (SELECT COUNT(*) FROM replay_receipts rr
				         WHERE rr.namespace = 'supplier_callback') AS callbacks
				 FROM supplier_orders so WHERE so.id = ?`,
			)
			.bind(supplierOrder?.id)
			.first();
		expect(state).toMatchObject({
			state: "supplied",
			cards: 2,
			callbacks: 2,
		});
		const evidenceRows = await db
			.prepare(
				"SELECT object_key FROM supplier_exchange_records WHERE supplier_order_id = ? AND direction = 'callback'",
			)
			.bind(supplierOrder?.id)
			.all<{ object_key: string }>();
		expect(evidenceRows.results).toHaveLength(3);
		const encrypted = await (
			await files.get(evidenceRows.results[0]?.object_key ?? "")
		)?.text();
		const artifact = JSON.parse(
			await decryptSecret(
				encrypted ?? "",
				runtime.commerceSecret,
				"supplier-diagnostic",
			),
		);
		expect(JSON.stringify(artifact)).not.toContain("api-secret");
		expect(JSON.stringify(artifact.request.headers)).not.toContain(
			"Dujiao-Next",
		);
		expect(artifact.request.body).toContain("CALLBACK-1");
		expect(encrypted).not.toContain("CALLBACK-1");
	});

	it("rejects an oversized chunked supplier callback with 413", async () => {
		const request = new Request(
			"https://shop.example/api/suppliers/dujiao-next/callback/account",
			{
				method: "POST",
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(700_000));
						controller.enqueue(new Uint8Array(700_000));
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit & { duplex: "half" },
		);
		const response = await handleDujiaoSupplierCallback(
			request,
			"account",
			db,
			1_800_000_000_000,
		);
		expect(response.status).toBe(413);
		await expect(response.json()).resolves.toEqual({
			ok: false,
			message: "body_too_large",
		});
	});
});

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

const pendingSupplierFetcher: typeof fetch = async (input) => {
	const url = new URL(
		typeof input === "string"
			? input
			: input instanceof URL
				? input
				: input.url,
	);
	if (url.pathname === "/api/v1/upstream/ping")
		return Response.json({
			ok: true,
			site_name: "Supplier",
			balance: "100.00",
			currency: "CNY",
		});
	if (url.pathname === "/api/v1/upstream/products/1")
		return Response.json({ ok: true, product: upstreamProduct() });
	if (url.pathname === "/api/v1/upstream/categories")
		return Response.json({ ok: true, categories: [] });
	if (url.pathname === "/api/v1/upstream/orders")
		return Response.json({ ok: true, order_id: 99, status: "pending" });
	throw new Error(`Unexpected URL ${url}`);
};
