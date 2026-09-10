import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const mocked = vi.hoisted(() => ({ db: undefined as D1Database | undefined }));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("#/server/context", () => ({
	getAdminRuntimeServerContext: async () => ({
		db: mocked.db,
		currentUser: { id: ADMIN_ID },
		request: new Request("https://shop.example/admin/aisou-inventory", {
			headers: { "x-request-id": "request-1", "cf-connecting-ip": "127.0.0.1" },
		}),
	}),
}));

import {
	importAisouInventory,
	listAisouInventory,
} from "#/features/aisou-inventory/server/admin";

describe("AISOU inventory admin", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "gmshop-aisou-inventory-admin" },
		});
		db = await miniflare.getD1Database("DB");
		mocked.db = db;
		await applyMigrations(db);
		await seed(db);
	});

	afterAll(async () => miniflare.dispose());

	it("imports AISOU cards once and reports owned status and cost", async () => {
		const cards = ["AISOU-PH-AAAA-BBBB-0001", "AISOU-PH-CCCC-DDDD-0002"];
		await db
			.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint,
				  content_mask, status, note, created_at, updated_at)
				 VALUES ('legacy-aisou', ?, 'legacy-encrypted', 1, 'legacy-fingerprint',
				  '••••0000', 'available', 'Skill快速补货; source=aisou; request_ref=legacy', 1, 1)`,
			)
			.bind(ITEM_ID)
			.run();
		await expect(
			importAisouInventory(
				{
					requestRef: "aisou_batch_00000001",
					componentId: ITEM_ID,
					unitCostYuan: "1030.00",
					content: cards.join("\n"),
					usageUrl: "https://aiee.fun/",
				},
				testContext(db),
			),
		).resolves.toMatchObject({ imported: 2, duplicates: 0, idempotent: false });

		const stored = await db
			.prepare(
				`SELECT content_encrypted, procurement_source, procurement_request_ref,
				 unit_cost_minor FROM stock_entries WHERE procurement_source = 'aisou'
				 ORDER BY id`,
			)
			.all<{
				content_encrypted: string;
				procurement_source: string;
				procurement_request_ref: string;
				unit_cost_minor: string;
			}>();
		expect(JSON.stringify(stored.results)).not.toContain(cards[0]);
		expect(stored.results[0]).toMatchObject({
			procurement_source: "aisou",
			procurement_request_ref: "aisou_batch_00000001",
			unit_cost_minor: "103000",
		});
		expect(
			await decryptSecret(
				stored.results[0]?.content_encrypted ?? "",
				COMMERCE_SECRET,
				"stock-entry",
			),
		).toContain("充值地址：https://aiee.fun/");

		await db
			.prepare(
				`UPDATE stock_entries SET status='delivered', delivered_at=2, updated_at=2
				 WHERE id=(SELECT id FROM stock_entries WHERE procurement_request_ref = ? LIMIT 1)`,
			)
			.bind("aisou_batch_00000001")
			.run();
		await expect(listAisouInventory(db)).resolves.toEqual([
			expect.objectContaining({
				componentId: ITEM_ID,
				available: 2,
				reserved: 0,
				delivered: 1,
				disabled: 0,
				costedAvailable: 1,
				availableValueMinor: "103000",
				latestUnitCostMinor: "103000",
			}),
		]);

		await expect(
			importAisouInventory(
				{
					requestRef: "aisou_batch_00000001",
					componentId: ITEM_ID,
					unitCostYuan: "1030.00",
					content: cards.join("\n"),
					usageUrl: "https://aiee.fun/",
				},
				testContext(db),
			),
		).resolves.toMatchObject({ imported: 0, idempotent: true });
	});

	it("rejects duplicate input and non-AISOU targets", async () => {
		await expect(
			importAisouInventory(
				{
					requestRef: "aisou_batch_00000002",
					componentId: ITEM_ID,
					unitCostYuan: "1000",
					content: "DUPLICATE-CARD\nDUPLICATE-CARD",
					usageUrl: "https://aiee.fun/",
				},
				testContext(db),
			),
		).rejects.toMatchObject({ code: "aisou_inventory_duplicate_input" });

		await expect(
			importAisouInventory(
				{
					requestRef: "aisou_batch_00000003",
					componentId: OTHER_ITEM_ID,
					unitCostYuan: "1000",
					content: "OTHER-CARD",
					usageUrl: "https://aiee.fun/",
				},
				testContext(db),
			),
		).rejects.toMatchObject({ code: "aisou_inventory_target_not_found" });
	});
});

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRODUCT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_ITEM_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const COMMERCE_SECRET = "aisou-inventory-integration-commerce-secret";

function testContext(db: D1Database) {
	return {
		db,
		request: new Request("https://shop.example/admin/aisou-inventory", {
			headers: { "x-request-id": "request-1", "cf-connecting-ip": "127.0.0.1" },
		}),
	};
}

async function seed(db: D1Database) {
	await db.batch([
		db
			.prepare(
				`INSERT INTO users (id, name, email, email_verified, enabled, created_at, updated_at)
				 VALUES (?, 'Admin', 'admin@example.com', 1, 1, 1, 1)`,
			)
			.bind(ADMIN_ID),
		db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1)`,
			)
			.bind(JSON.stringify(COMMERCE_SECRET)),
		db
			.prepare(
				`INSERT INTO products (id, name, product_type, status, created_at, updated_at)
				 VALUES (?, 'ChatGPT Pro', 'stock', 'active', 1, 1)`,
			)
			.bind(PRODUCT_ID),
		db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, fulfillment_source, supplier_status, currency,
				  currency_decimals, price_minor, enabled, sort_order, created_at, updated_at)
				 VALUES (?, ?, '20X 菲区', 'local', NULL, 'CNY', 2, '120000', 1, 1, 1, 1)`,
			)
			.bind(ITEM_ID, PRODUCT_ID),
		db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, fulfillment_source, currency, currency_decimals,
				  price_minor, enabled, sort_order, created_at, updated_at)
				 VALUES (?, ?, 'iOS', 'local', 'CNY', 2, '120000', 1, 2, 1, 1)`,
			)
			.bind(OTHER_ITEM_ID, PRODUCT_ID),
		db.prepare(
			`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version, currency,
			  currency_decimals, name, credentials_encrypted, credentials_revision,
			  credential_fingerprint, health_status, enabled, created_at, updated_at)
			 VALUES ('account', 'shared_stock', 'https://supplier.example',
			  'https://supplier.example', '1', 'CNY', 2, 'AISOU', 'encrypted', 1,
			  'fingerprint', 'healthy', 1, 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO supplier_bindings
				 (id, sellable_item_id, provider, normalized_api_origin, protocol_version,
				  upstream_product_id, upstream_sku_id, upstream_product_name,
				  upstream_sku_name, reference_cost_minor, max_cost_minor, stock_quantity,
				  remote_status, enabled, created_at, updated_at)
				 VALUES ('binding', ?, 'shared_stock', 'https://supplier.example', '1',
				  'remote-product', 'remote-sku', 'ChatGPT Pro', '20X PH', '105000',
				  '110000', 30, 'active', 1, 1, 1)`,
			)
			.bind(ITEM_ID),
	]);
}
