import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const mocked = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("#/server/context", () => ({
	getAdminRuntimeServerContext: async () => ({
		db: mocked.db,
		currentUser: { id: ADMIN_ID },
		request: new Request("https://shop.example/admin/redeem-inventory", {
			headers: { "x-request-id": "request-1", "cf-connecting-ip": "127.0.0.1" },
		}),
		runtime: { commerceSecret: COMMERCE_SECRET },
	}),
}));

import {
	generateRedeemSellableInventory,
	quickRestockRedeemWarehouse,
	requestWarehouse,
} from "#/features/redeem-warehouse/server/admin";

describe("redeem warehouse admin", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-redeem-warehouse-admin" },
		});
		db = await miniflare.getD1Database("DB");
		mocked.db = db;
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it.each([
		"GPT_PLUS_IOS",
		"GPT_PLUS_PH",
		"GPT_5X_PH",
		"GPT_20X_PH",
	])("generates idempotent owned delivery for %s without returning raw codes", async (sku) => {
		await db.prepare("DELETE FROM stock_entries").run();
		await db
			.prepare(
				"DELETE FROM replay_receipts WHERE namespace = 'redeem_sellable_generation'",
			)
			.run();
		const prefix = sku.toLowerCase().replaceAll("_", "-");
		const testCodes = [
			`${prefix}-AAAA-BBBB-CCCC-DDDD`,
			`${prefix}-EEEE-FFFF-GGGG-HHHH`,
		];
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/api/internal/inventory/summary"))
				return Response.json({ success: true, data: inventoryRows() });
			if (url.endsWith("/api/internal/codes/batch"))
				return Response.json({
					success: true,
					data: { sku, count: 2, codes: testCodes },
				});
			return Response.json({ success: false }, { status: 404 });
		});
		const requester: typeof requestWarehouse = (token, path, init) =>
			requestWarehouse(token, path, init, fetcher as typeof fetch);
		const input = {
			requestRef: "redeem_generation_0001",
			sku,
			componentId: ITEM_ID,
			count: 2,
		};
		await expect(
			generateRedeemSellableInventory(input, testContext(db), requester),
		).resolves.toEqual({
			idempotent: false,
			imported: 2,
			count: 2,
		});
		const rows = await db
			.prepare(
				"SELECT content_encrypted, content_mask, note FROM stock_entries WHERE sellable_item_id = ? ORDER BY content_mask",
			)
			.bind(ITEM_ID)
			.all<{ content_encrypted: string; content_mask: string; note: string }>();
		expect(rows.results).toHaveLength(2);
		expect(JSON.stringify(rows.results)).not.toContain(testCodes[0]);
		expect(rows.results[0]?.note).toContain(`sku=${sku}`);
		const delivery = await decryptSecret(
			rows.results[0]?.content_encrypted ?? "",
			COMMERCE_SECRET,
			"stock-entry",
		);
		expect(delivery).toContain(`CDK：${prefix}-`);
		expect(delivery).toContain("充值地址：https://redeem.lsrai.shop");

		await expect(
			generateRedeemSellableInventory(input, testContext(db), requester),
		).resolves.toEqual({
			idempotent: true,
			imported: 0,
			count: 2,
		});
		await expect(
			generateRedeemSellableInventory(
				{ ...input, count: 3 },
				testContext(db),
				requester,
			),
		).rejects.toMatchObject({
			code: "redeem_sellable_request_conflict",
			status: 409,
		});
		expect(
			fetcher.mock.calls.filter(([url]) =>
				String(url).endsWith("/api/internal/codes/batch"),
			),
		).toHaveLength(1);
	});
});

describe("redeem warehouse quick restock", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-redeem-quick-restock" },
		});
		db = await miniflare.getD1Database("DB");
		mocked.db = db;
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	function warehouse(batchStatus = 200) {
		return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/api/internal/inventory/import")) {
				const body = JSON.parse(String(init?.body)) as { keys: string[] };
				return Response.json({
					success: true,
					data: {
						imported: 1,
						total: body.keys.length,
						results: [
							{ index: 0, status: "available" },
							{ index: 1, status: "quarantined", reason: "used" },
							{ index: 2, status: "duplicate" },
						],
					},
				});
			}
			if (url.endsWith("/api/internal/codes/batch")) {
				if (batchStatus !== 200)
					return Response.json({ success: false }, { status: batchStatus });
				const body = JSON.parse(String(init?.body)) as { count: number };
				return Response.json({
					success: true,
					data: {
						sku: "GPT_20X_IOS",
						count: body.count,
						codes: Array.from(
							{ length: body.count },
							(_, index) => `gpt-20x-ios-QUICK-${index}-CCCC-DDDD`,
						),
					},
				});
			}
			return Response.json({ success: false }, { status: 404 });
		});
	}

	it("issues storefront stock only for keys the warehouse accepted", async () => {
		await db.prepare("DELETE FROM stock_entries").run();
		const fetcher = warehouse();
		const requester: typeof requestWarehouse = (token, path, init) =>
			requestWarehouse(token, path, init, fetcher as typeof fetch);
		await expect(
			quickRestockRedeemWarehouse(
				{
					requestRef: "restock_quick_0000001",
					sku: "GPT_20X_IOS",
					componentId: ITEM_ID,
					unitCostYuan: "1600",
					content: "KEY-READY\nKEY-USED\nKEY-DUPLICATE",
				},
				testContext(db),
				requester,
			),
		).resolves.toEqual({
			total: 3,
			imported: 1,
			counts: { available: 1, quarantined: 1, duplicate: 1 },
			generated: 1,
			generationFailed: false,
		});
		const batch = fetcher.mock.calls.find(([url]) =>
			String(url).endsWith("/api/internal/codes/batch"),
		);
		expect(JSON.parse(String(batch?.[1]?.body))).toMatchObject({ count: 1 });
		const stock = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM stock_entries WHERE sellable_item_id = ? AND status = 'available'",
			)
			.bind(ITEM_ID)
			.first<{ count: number }>();
		expect(stock?.count).toBe(1);
		const target = await db
			.prepare(
				"SELECT value FROM system_settings WHERE key = 'integration.redeem_warehouse_targets'",
			)
			.first<{ value: string }>();
		expect(JSON.parse(JSON.parse(target?.value ?? '""'))).toEqual({
			GPT_20X_IOS: ITEM_ID,
		});
	});

	it("runs without an acting user for the token-authenticated ops API", async () => {
		await db.prepare("DELETE FROM stock_entries").run();
		const fetcher = warehouse();
		const requester: typeof requestWarehouse = (token, path, init) =>
			requestWarehouse(token, path, init, fetcher as typeof fetch);
		await expect(
			quickRestockRedeemWarehouse(
				{
					requestRef: "restock_quick_ops_0001",
					sku: "GPT_20X_IOS",
					componentId: ITEM_ID,
					content: "KEY-READY\nKEY-USED\nKEY-DUPLICATE",
				},
				{
					db,
					currentUser: { id: null },
					request: new Request("https://shop.example/api/ops/redeem-restock"),
					runtime: { commerceSecret: COMMERCE_SECRET },
				},
				requester,
			),
		).resolves.toMatchObject({ imported: 1, generated: 1 });
		const audit = await db
			.prepare(
				"SELECT COUNT(*) AS count FROM audit_logs WHERE actor_user_id IS NULL AND action LIKE 'redeem_warehouse.%'",
			)
			.first<{ count: number }>();
		expect(audit?.count).toBeGreaterThanOrEqual(2);
	});

	it("refuses a sale-disabled item before touching the warehouse", async () => {
		const fetcher = warehouse();
		const requester: typeof requestWarehouse = (token, path, init) =>
			requestWarehouse(token, path, init, fetcher as typeof fetch);
		await expect(
			quickRestockRedeemWarehouse(
				{
					requestRef: "restock_quick_0000002",
					sku: "GPT_20X_IOS",
					componentId: DISABLED_ITEM_ID,
					content: "KEY-READY",
				},
				testContext(db),
				requester,
			),
		).rejects.toMatchObject({ code: "redeem_sellable_component_not_found" });
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("reports imported keys when storefront generation fails", async () => {
		const fetcher = warehouse(502);
		const requester: typeof requestWarehouse = (token, path, init) =>
			requestWarehouse(token, path, init, fetcher as typeof fetch);
		await expect(
			quickRestockRedeemWarehouse(
				{
					requestRef: "restock_quick_0000003",
					sku: "GPT_20X_IOS",
					componentId: ITEM_ID,
					content: "KEY-READY\nKEY-USED\nKEY-DUPLICATE",
				},
				testContext(db),
				requester,
			),
		).resolves.toMatchObject({
			imported: 1,
			generated: 0,
			generationFailed: true,
		});
	});
});

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DISABLED_ITEM_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PRODUCT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const COMMERCE_SECRET = "redeem-warehouse-integration-commerce-secret";

async function seed(db: D1Database) {
	const token = await encryptSecret(
		"test-internal-token-value-1234567890",
		COMMERCE_SECRET,
		"redeem-warehouse-token",
	);
	await db.batch([
		db
			.prepare(
				`INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at)
			 VALUES (?, 'Admin', 'admin@example.com', 1, 1, 1, 1)`,
			)
			.bind(ADMIN_ID),
		db
			.prepare(
				`INSERT INTO products (id, name, product_type, status, created_at, updated_at)
			 VALUES (?, 'ChatGPT', 'stock', 'active', 1, 1)`,
			)
			.bind(PRODUCT_ID),
		db
			.prepare(
				`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, currency, currency_decimals, price_minor, created_at, updated_at)
			 VALUES (?, ?, 'Plus iOS', 'local', 'CNY', 2, '15000', 1, 1)`,
			)
			.bind(ITEM_ID, PRODUCT_ID),
		db
			.prepare(
				`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, currency, currency_decimals, price_minor, sale_disabled, created_at, updated_at)
			 VALUES (?, ?, 'Retired 20X iOS', 'local', 'CNY', 2, '15000', 1, 1, 1)`,
			)
			.bind(DISABLED_ITEM_ID, PRODUCT_ID),
		db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('integration.redeem_warehouse_token', ?, 1, 1, 1)`,
			)
			.bind(JSON.stringify(token)),
	]);
}

function testContext(db: D1Database) {
	return {
		db,
		currentUser: { id: ADMIN_ID },
		request: new Request("https://shop.example/admin/redeem-inventory", {
			headers: {
				"x-request-id": "request-1",
				"cf-connecting-ip": "127.0.0.1",
			},
		}),
		runtime: { commerceSecret: COMMERCE_SECRET },
	} as never;
}

function inventoryRows() {
	const skus = [
		"GPT_GO_IOS",
		"GPT_PLUS_IOS",
		"GPT_5X_IOS",
		"GPT_20X_IOS",
		"CLAUDE_PRO_IOS",
		"CLAUDE_MAX_5X_IOS",
		"CLAUDE_MAX_20X_IOS",
	];
	return skus.map((sku) => ({
		sku,
		display_name: sku,
		family: sku.startsWith("GPT") ? "gpt" : "claude",
		input_kind: sku.startsWith("GPT") ? "gpt_session" : "claude_session_key",
		available: 0,
		leased: 0,
		processing: 0,
		consumed: 0,
		quarantined: 0,
	}));
}
