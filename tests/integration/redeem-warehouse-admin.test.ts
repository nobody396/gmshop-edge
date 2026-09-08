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

	it("generates idempotent sellable inventory without returning raw codes", async () => {
		const testCodes = [
			"gpt-plus-ios-AAAA-BBBB-CCCC-DDDD",
			"gpt-plus-ios-EEEE-FFFF-GGGG-HHHH",
		];
		const fetcher = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/api/internal/inventory/summary"))
				return Response.json({ success: true, data: inventoryRows() });
			if (url.endsWith("/api/internal/codes/batch"))
				return Response.json({
					success: true,
					data: { sku: "GPT_PLUS_IOS", count: 2, codes: testCodes },
				});
			return Response.json({ success: false }, { status: 404 });
		});
		const requester: typeof requestWarehouse = (token, path, init) =>
			requestWarehouse(token, path, init, fetcher as typeof fetch);
		const input = {
			requestRef: "redeem_generation_0001",
			sku: "GPT_PLUS_IOS",
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
		expect(rows.results[0]?.note).toContain("sku=GPT_PLUS_IOS");
		const delivery = await decryptSecret(
			rows.results[0]?.content_encrypted ?? "",
			COMMERCE_SECRET,
			"stock-entry",
		);
		expect(delivery).toContain("CDK：gpt-plus-ios-");
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

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
