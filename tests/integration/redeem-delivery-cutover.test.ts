import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDeliveryReconcileRequest } from "#/features/catalog/server/restock-api";
import { decryptDeliveryContent } from "#/features/fulfillment/secrets";
import {
	completeManualDelivery,
	processDelivery,
} from "#/features/fulfillment/server/process";
import {
	type ConvertibleStock,
	convertReservedStock,
} from "#/features/redeem-warehouse/server/convert-delivery";
import { handleRedeemCutover } from "#/features/redeem-warehouse/server/delivery-cutover";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { applyMigrations } from "./migrations";

const component = "362d3add-4901-4b4c-b6a9-27aea63473e4",
	stock = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secret = "fixture-commerce-secret",
	raw = "FIXTURE-PH-RAW-KEY",
	local = "gpt-plus-ph-AAAA-BBBB-CCCC-DDDD";
const response = { success: true, data: { sku: "GPT_PLUS_PH", cdkey: local } };

describe("no-pause owned redemption delivery", { timeout: 30000 }, () => {
	let mf: Miniflare, db: D1Database;
	beforeEach(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db.batch([
			db
				.prepare(
					"INSERT INTO system_settings (key,value,is_secret) VALUES ('runtime.data_encryption_secret',?,1)",
				)
				.bind(JSON.stringify(secret)),
			db
				.prepare(
					"INSERT INTO system_settings (key,value,is_secret) VALUES ('integration.redeem_warehouse_token',?,1)",
				)
				.bind(
					JSON.stringify(
						await encryptSecret(
							"fixture-token",
							secret,
							"redeem-warehouse-token",
						),
					),
				),
			db.prepare(
				"INSERT INTO products (id,name,product_type,status) VALUES ('p','ChatGPT','stock','active')",
			),
			db
				.prepare(
					"INSERT INTO product_sellable_items (id,product_id,name,fulfillment_source,currency,currency_decimals,price_minor) VALUES (?,'p','ChatGPT Plus 菲区 1个月','local','CNY',2,'12000')",
				)
				.bind(component),
			db.prepare(
				"INSERT INTO shop_orders (id,order_number,status,currency,currency_decimals,subtotal_minor,discount_minor,total_minor,paid_minor,version,expires_at) VALUES ('o','GMfixture','paid','CNY',2,'12000','0','12000','12000',1,9999999999999)",
			),
			db
				.prepare(
					"INSERT INTO shop_order_items (id,order_id,product_id,sellable_item_id,product_name,delivery_component_id,delivery_component_type,delivery_component_version,sellable_item_name,quantity,unit_price_minor,subtotal_minor) VALUES ('i','o','p',?,'ChatGPT',?,'stock',1,'PH',1,'12000','12000')",
				)
				.bind(component, component),
			db
				.prepare(
					"INSERT INTO stock_entries (id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status,order_item_id,unit_cost_minor,procurement_source) VALUES (?,?,?,1,'raw-fingerprint','masked','reserved','i','11500','aisou')",
				)
				.bind(
					stock,
					component,
					await encryptSecret(
						`CDK：${raw}\n充值地址：https://aiee.fun/`,
						secret,
						"stock-entry",
					),
				),
		]);
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		await mf.dispose();
	});
	const getEntry = async () => {
		const row = await db
			.prepare(
				"SELECT id,content_encrypted,content_fingerprint,unit_cost_minor,redeem_sku FROM stock_entries WHERE id=?",
			)
			.bind(stock)
			.first<ConvertibleStock>();
		if (!row) throw new Error("Fixture stock missing");
		return row;
	};
	async function route(sku: string | null) {
		await db
			.prepare(
				"INSERT INTO system_settings (key,value,is_secret) VALUES (?,?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
			)
			.bind(`integration.redeem_delivery.${component}`, JSON.stringify(sku))
			.run();
	}
	async function delivery(id = "d") {
		await db
			.prepare(
				"INSERT INTO delivery_records (id,order_item_id,delivery_type,status,request_key) VALUES (?,'i','stock','pending',?)",
			)
			.bind(id, id)
			.run();
	}
	it("snapshots new deliveries only, without modifying stock availability or product switches", async () => {
		await delivery("old");
		await route("GPT_PLUS_PH");
		await delivery("new");
		await route(null);
		await delivery("rollback");
		const rows = await db
			.prepare("SELECT id,redeem_sku FROM delivery_records ORDER BY id")
			.all();
		expect(rows.results).toEqual([
			{ id: "new", redeem_sku: "GPT_PLUS_PH" },
			{ id: "old", redeem_sku: null },
			{ id: "rollback", redeem_sku: null },
		]);
		expect(
			(
				await db
					.prepare("SELECT enabled FROM product_sellable_items WHERE id=?")
					.bind(component)
					.first()
			)?.enabled,
		).toBe(1);
		expect(
			(
				await db
					.prepare("SELECT status FROM stock_entries WHERE id=?")
					.bind(stock)
					.first()
			)?.status,
		).toBe("reserved");
	});
	it("delivers only owned CDK and URL through the existing common delivery process", async () => {
		await route("GPT_PLUS_PH");
		await delivery();
		const fetcher = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://redeem.laoshirenvip.com/api/internal/fulfillment/convert",
				);
				expect(JSON.parse(String(init?.body))).toMatchObject({
					sku: "GPT_PLUS_PH",
					source_ref: `gmstock-${stock}`,
					key: raw,
					unit_cost_minor: "11500",
				});
				return Response.json(response);
			},
		);
		vi.stubGlobal("fetch", fetcher);
		expect(await processDelivery(db, "d")).toMatchObject({
			status: "delivered",
		});
		const record = await db
			.prepare("SELECT content_encrypted FROM delivery_records WHERE id='d'")
			.first<{ content_encrypted: string }>();
		const content = await decryptDeliveryContent(
			record?.content_encrypted ?? "",
			secret,
		);
		expect(content).toBe(`CDK：${local}\n充值地址：https://redeem.lsrai.shop`);
		expect(content).not.toContain(raw);
		const stored = await getEntry();
		expect(stored?.redeem_sku).toBe("GPT_PLUS_PH");
		expect(stored?.content_fingerprint).toBe("raw-fingerprint");
		expect(stored?.unit_cost_minor).toBe("11500");
		await processDelivery(db, "d");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("central failure never falls back to raw customer delivery or a new supplier purchase", async () => {
		await route("GPT_PLUS_PH");
		await delivery();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("fixture transport failure");
			}),
		);
		await expect(processDelivery(db, "d")).rejects.toMatchObject({
			code: "redeem_warehouse_unreachable",
		});
		expect(
			await db
				.prepare(
					"SELECT status,content_encrypted FROM delivery_records WHERE id='d'",
				)
				.first(),
		).toEqual({ status: "pending", content_encrypted: null });
		expect((await getEntry())?.redeem_sku).toBeNull();
		const audit = await db
			.prepare(
				"SELECT after FROM audit_logs WHERE action='redeem_delivery.failure'",
			)
			.all<{ after: string }>();
		expect(audit.results).toHaveLength(1);
		expect(audit.results[0]?.after).toContain("conversion");
		expect(JSON.stringify(audit.results)).not.toContain(raw);

		expect(
			(
				await db
					.prepare("SELECT COUNT(*) AS count FROM supplier_orders")
					.first()
			)?.count,
		).toBe(0);
	});
	it("same reserved row concurrent conversion persists one local code and retains upstream dedup fingerprint", async () => {
		const entry = await getEntry();
		const requester = vi.fn(async () => response);
		const results = await Promise.all([
			convertReservedStock(
				db,
				entry,
				"i",
				"GPT_PLUS_PH",
				secret,
				"token",
				requester,
			),
			convertReservedStock(
				db,
				entry,
				"i",
				"GPT_PLUS_PH",
				secret,
				"token",
				requester,
			),
		]);
		expect(results[0]).toBe(results[1]);
		expect(results[0]).toContain(local);
		expect((await getEntry())?.content_fingerprint).toBe("raw-fingerprint");
	});
	it("refund winning source CAS hides the converted code; later ownership can safely reuse its reference", async () => {
		const entry = await getEntry();
		const raced = async () => {
			await db.batch([
				db
					.prepare(
						"UPDATE stock_entries SET status='available',order_item_id=NULL WHERE id=?",
					)
					.bind(stock),
				db.prepare("UPDATE shop_orders SET status='cancelled' WHERE id='o'"),
			]);
			return response;
		};
		await expect(
			convertReservedStock(
				db,
				entry,
				"i",
				"GPT_PLUS_PH",
				secret,
				"token",
				raced,
			),
		).rejects.toMatchObject({ code: "redeem_delivery_state_changed" });
		expect((await getEntry())?.redeem_sku).toBeNull();
		await db.batch([
			db.prepare("UPDATE shop_orders SET status='paid' WHERE id='o'"),
			db
				.prepare(
					"UPDATE stock_entries SET status='reserved',order_item_id='i' WHERE id=?",
				)
				.bind(stock),
		]);
		expect(
			await convertReservedStock(
				db,
				entry,
				"i",
				"GPT_PLUS_PH",
				secret,
				"token",
				async () => response,
			),
		).toContain(local);
	});
	it("refund after conversion never restores the original raw key when the card is resold", async () => {
		await convertReservedStock(
			db,
			await getEntry(),
			"i",
			"GPT_PLUS_PH",
			secret,
			"token",
			async () => response,
		);
		await db
			.prepare(
				"UPDATE stock_entries SET status='available',order_item_id=NULL WHERE id=?",
			)
			.bind(stock)
			.run();
		const entry = await getEntry();
		expect(
			await decryptSecret(entry.content_encrypted, secret, "stock-entry"),
		).not.toContain(raw);
		await db
			.prepare(
				"UPDATE stock_entries SET status='reserved',order_item_id='i' WHERE id=?",
			)
			.bind(stock)
			.run();
		const requester = vi.fn(async () => response);
		expect(
			await convertReservedStock(
				db,
				entry,
				"i",
				"GPT_PLUS_PH",
				secret,
				"token",
				requester,
			),
		).toContain(local);
		expect(requester).not.toHaveBeenCalled();
	});
	it("cancellation after conversion must abort all finalization writes atomically", async () => {
		await route("GPT_PLUS_PH");
		await delivery();
		await convertReservedStock(
			db,
			await getEntry(),
			"i",
			"GPT_PLUS_PH",
			secret,
			"token",
			async () => response,
		);
		await db
			.prepare("UPDATE shop_orders SET status='cancelled' WHERE id='o'")
			.run();
		await expect(processDelivery(db, "d")).rejects.toThrow();
		expect(
			(
				await db
					.prepare("SELECT status FROM stock_entries WHERE id=?")
					.bind(stock)
					.first()
			)?.status,
		).toBe("reserved");
		expect(
			(await db.prepare("SELECT status FROM shop_orders WHERE id='o'").first())
				?.status,
		).toBe("cancelled");
		expect(
			(
				await db
					.prepare("SELECT status FROM delivery_records WHERE id='d'")
					.first()
			)?.status,
		).toBe("pending");
		expect(
			(
				await db
					.prepare(
						"SELECT COUNT(*) AS count FROM outbox_events WHERE event_type='delivery.ready'",
					)
					.first()
			)?.count,
		).toBe(0);
	});
	it("rejects a mismatched returned SKU before altering source inventory", async () => {
		await expect(
			convertReservedStock(
				db,
				await getEntry(),
				"i",
				"GPT_PLUS_PH",
				secret,
				"token",
				async () => ({
					success: true,
					data: { sku: "GPT_5X_PH", cdkey: local },
				}),
			),
		).rejects.toMatchObject({ code: "redeem_delivery_response_mismatch" });
		expect((await getEntry())?.redeem_sku).toBeNull();
	});
	it("enables only the selected PH route after warehouse readiness and rolls back without touching existing snapshots", async () => {
		const env = {
			DB: db,
			RESTOCK_API_TOKEN: "fixture-ops",
		} as CloudflareBindings;
		const fetcher = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://redeem.laoshirenvip.com/api/internal/inventory/summary",
				);
				expect(init?.body).toBeUndefined();
				return Response.json({
					success: true,
					conversion_api_version: 1,
					data: [{ sku: "GPT_PLUS_PH" }],
				});
			},
		);
		vi.stubGlobal("fetch", fetcher);
		await delivery("old");
		const post = async (enabled: boolean, dryRun = false) =>
			handleRedeemCutover(
				new Request("https://shop.example/api/ops/redeem-cutover", {
					method: "POST",
					headers: { Authorization: "Bearer fixture-ops" },
					body: JSON.stringify({
						componentId: component,
						sku: "GPT_PLUS_PH",
						enabled,
						dryRun,
						requestRef: enabled
							? "fixture-cutover-enable"
							: "fixture-cutover-disable",
					}),
				}),
				env,
			);
		expect((await post(true, true)).status).toBe(200);
		expect(
			await db
				.prepare("SELECT value FROM system_settings WHERE key=?")
				.bind(`integration.redeem_delivery.${component}`)
				.first(),
		).toBeNull();
		expect((await post(true)).status).toBe(200);
		await delivery("new");
		expect((await post(false)).status).toBe(200);
		await delivery("after-rollback");
		expect((await post(true)).status).toBe(200);
		expect(
			(
				await db
					.prepare("SELECT value FROM system_settings WHERE key=?")
					.bind(`integration.redeem_delivery.${component}`)
					.first()
			)?.value,
		).toBe("null");
		expect(
			(
				await db
					.prepare("SELECT redeem_sku FROM delivery_records WHERE id='new'")
					.first()
			)?.redeem_sku,
		).toBe("GPT_PLUS_PH");
		expect(
			(
				await db
					.prepare("SELECT redeem_sku FROM delivery_records WHERE id='old'")
					.first()
			)?.redeem_sku,
		).toBeNull();
		expect(
			(
				await db
					.prepare(
						"SELECT redeem_sku FROM delivery_records WHERE id='after-rollback'",
					)
					.first()
			)?.redeem_sku,
		).toBeNull();
		expect(
			(
				await db
					.prepare("SELECT status FROM stock_entries WHERE id=?")
					.bind(stock)
					.first()
			)?.status,
		).toBe("reserved");
	});
	it("targets only one unpaid trial order, leaving all other PH orders on the old route", async () => {
		const number = `GM${"A".repeat(32)}`;
		await db
			.prepare(
				"UPDATE shop_orders SET status='pending_payment',order_number=? WHERE id='o'",
			)
			.bind(number)
			.run();
		await db
			.prepare(
				"UPDATE stock_entries SET status='available',order_item_id=NULL WHERE id=?",
			)
			.bind(stock)
			.run();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				expect(String(input)).toBe(
					"https://redeem.laoshirenvip.com/api/internal/inventory/summary",
				);
				expect(init?.body).toBeUndefined();
				return Response.json({
					success: true,
					conversion_api_version: 1,
					data: [{ sku: "GPT_PLUS_PH" }],
				});
			}),
		);
		const body = {
			componentId: component,
			sku: "GPT_PLUS_PH",
			enabled: true,
			trialOrderNumber: number,
			requestRef: "fixture-trial-order-1",
		};
		const request = () =>
			new Request("https://shop.example/api/ops/redeem-cutover", {
				method: "POST",
				headers: { Authorization: "Bearer fixture-ops" },
				body: JSON.stringify(body),
			});
		const env = {
			DB: db,
			RESTOCK_API_TOKEN: "fixture-ops",
		} as CloudflareBindings;
		expect((await handleRedeemCutover(request(), env)).status).toBe(200);
		expect(
			await db
				.prepare("SELECT value FROM system_settings WHERE key=?")
				.bind(`integration.redeem_delivery.${component}`)
				.first(),
		).toBeNull();
		await db.prepare("UPDATE shop_orders SET status='paid' WHERE id='o'").run();
		await delivery("trial");
		await db.batch([
			db.prepare(
				"INSERT INTO shop_orders (id,order_number,status,currency,currency_decimals,subtotal_minor,discount_minor,total_minor,paid_minor,version,expires_at) VALUES ('other','GMother','paid','CNY',2,'12000','0','12000','12000',1,9999999999999)",
			),
			db
				.prepare(
					"INSERT INTO shop_order_items (id,order_id,product_id,sellable_item_id,product_name,delivery_component_id,delivery_component_type,delivery_component_version,sellable_item_name,quantity,unit_price_minor,subtotal_minor) VALUES ('other-i','other','p',?,'GPT',?,'stock',1,'PH',1,'12000','12000')",
				)
				.bind(component, component),
			db.prepare(
				"INSERT INTO delivery_records (id,order_item_id,delivery_type,status,request_key) VALUES ('other-d','other-i','stock','pending','other-d')",
			),
		]);
		expect(
			(
				await db
					.prepare("SELECT redeem_sku FROM delivery_records WHERE id='trial'")
					.first()
			)?.redeem_sku,
		).toBe("GPT_PLUS_PH");
		expect(
			(
				await db
					.prepare("SELECT redeem_sku FROM delivery_records WHERE id='other-d'")
					.first()
			)?.redeem_sku,
		).toBeNull();
		expect((await handleRedeemCutover(request(), env)).status).toBe(200);
		body.requestRef = "fixture-trial-order-2";
		expect((await handleRedeemCutover(request(), env)).status).toBe(409);
	});
	it("payment winning the trial setup race cannot retroactively change a delivery snapshot", async () => {
		const number = `GM${"B".repeat(32)}`;
		await db
			.prepare(
				"UPDATE shop_orders SET status='pending_payment',order_number=? WHERE id='o'",
			)
			.bind(number)
			.run();
		await db
			.prepare(
				"UPDATE stock_entries SET status='available',order_item_id=NULL WHERE id=?",
			)
			.bind(stock)
			.run();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				if (String(input).endsWith("/inventory/summary")) {
					await db
						.prepare("UPDATE shop_orders SET status='paid' WHERE id='o'")
						.run();
					await delivery("raced");
					return Response.json({
						success: true,
						conversion_api_version: 1,
						data: [{ sku: "GPT_PLUS_PH" }],
					});
				}
				return Response.json({
					success: true,
					conversion_api_version: 1,
					data: [{ sku: "GPT_PLUS_PH" }],
				});
			}),
		);
		const request = new Request("https://shop.example/api/ops/redeem-cutover", {
			method: "POST",
			headers: { Authorization: "Bearer fixture-ops" },
			body: JSON.stringify({
				componentId: component,
				sku: "GPT_PLUS_PH",
				enabled: true,
				trialOrderNumber: number,
				requestRef: "fixture-trial-race",
			}),
		});
		expect(
			(
				await handleRedeemCutover(request, {
					DB: db,
					RESTOCK_API_TOKEN: "fixture-ops",
				} as CloudflareBindings)
			).status,
		).not.toBe(200);
		expect(
			(
				await db
					.prepare("SELECT redeem_sku FROM delivery_records WHERE id='raced'")
					.first()
			)?.redeem_sku,
		).toBeNull();
		expect(
			await db
				.prepare("SELECT value FROM system_settings WHERE key=?")
				.bind(`integration.redeem_delivery_trial.o.${component}`)
				.first(),
		).toBeNull();
	});
	it("legacy raw repair and manual delivery cannot bypass the owned-delivery snapshot", async () => {
		const number = `GM${"C".repeat(32)}`;
		await db
			.prepare("UPDATE shop_orders SET order_number=? WHERE id='o'")
			.bind(number)
			.run();
		await route("GPT_PLUS_PH");
		await delivery();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(response)),
		);
		await processDelivery(db, "d");
		const repaired = await handleDeliveryReconcileRequest(
			new Request("https://shop.example/api/ops/restock/reconcile", {
				method: "POST",
				headers: { Authorization: "Bearer fixture-ops" },
				body: JSON.stringify({
					requestRef: "fixture-raw-repair",
					orderNumber: number,
					secret: "OTHER-RAW-KEY",
					usageUrl: "https://aiee.fun/",
					source: "aisou",
				}),
			}),
			{ DB: db, RESTOCK_API_TOKEN: "fixture-ops" } as CloudflareBindings,
		);
		expect(repaired.status).toBe(409);
		expect(await repaired.json()).toMatchObject({
			error: "restock_owned_delivery_required",
		});
		await db
			.prepare(
				"UPDATE product_sellable_items SET fulfillment_source='manual' WHERE id=?",
			)
			.bind(component)
			.run();
		await expect(
			completeManualDelivery(db, "d", "OTHER-RAW-KEY"),
		).resolves.toMatchObject({ duplicate: true });
		await db
			.prepare("UPDATE delivery_records SET status='processing' WHERE id='d'")
			.run();
		await expect(
			completeManualDelivery(db, "d", "OTHER-RAW-KEY"),
		).rejects.toThrow();
		const content = await db
			.prepare("SELECT content_encrypted FROM delivery_records WHERE id='d'")
			.first<{ content_encrypted: string }>();
		expect(
			await decryptDeliveryContent(content?.content_encrypted || "", secret),
		).toContain(local);
	});
	it("a stale converted marker cannot turn edited raw content into customer delivery", async () => {
		await db
			.prepare("UPDATE stock_entries SET redeem_sku='GPT_PLUS_PH' WHERE id=?")
			.bind(stock)
			.run();
		await expect(
			convertReservedStock(
				db,
				await getEntry(),
				"i",
				"GPT_PLUS_PH",
				secret,
				"token",
				async () => response,
			),
		).rejects.toMatchObject({ code: "redeem_delivery_marker_conflict" });
	});
	it("cutover endpoint rejects missing authorization and refuses an iOS plan", async () => {
		const env = {
			DB: db,
			RESTOCK_API_TOKEN: "fixture-ops",
		} as CloudflareBindings;
		expect(
			(
				await handleRedeemCutover(
					new Request(
						`https://shop.example/api/ops/redeem-cutover?componentId=${component}`,
					),
					env,
				)
			).status,
		).toBe(401);
		const result = await handleRedeemCutover(
			new Request("https://shop.example/api/ops/redeem-cutover", {
				method: "POST",
				headers: { Authorization: "Bearer fixture-ops" },
				body: JSON.stringify({
					componentId: component,
					sku: "GPT_PLUS_IOS",
					enabled: true,
					requestRef: "fixture-cutover-1",
				}),
			}),
			env,
		);
		expect(result.status).toBe(400);
	});
});
