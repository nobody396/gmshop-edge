import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleRestockApiRequest } from "#/features/catalog/server/restock-api";
import { decryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const token = "test-restock-token-that-is-long-enough";
const componentId = "00000000-0000-4000-8000-000000000002";
const requestRef = "RESTOCK-TEST-0001";
const keyring = "0123456789abcdef0123456789abcdef";

describe("restock API", () => {
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

	it("rejects missing credentials without inspecting inventory", async () => {
		const response = await handleRestockApiRequest(
			new Request("https://shop.example/api/ops/restock", {
				method: "POST",
				body: JSON.stringify(payload()),
				headers: { "content-type": "application/json" },
			}),
			{ DB: db, RESTOCK_API_TOKEN: token },
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			ok: false,
			error: "restock_unauthorized",
		});
	});

	it("imports one supplier-backed CDK with its recharge URL and is idempotent", async () => {
		const first = await request("POST", payload());
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			ok: true,
			idempotent: false,
			imported: 1,
			duplicates: 0,
			counts: { available: 1 },
		});

		const row = await db
			.prepare(
				"SELECT content_encrypted, content_mask, note FROM stock_entries WHERE sellable_item_id = ?",
			)
			.bind(componentId)
			.first<{
				content_encrypted: string;
				content_mask: string;
				note: string;
			}>();
		expect(row?.content_mask).toBe("••••••••-001");
		expect(row?.note).toContain("source=86");
		expect(
			await decryptSecret(row?.content_encrypted ?? "", keyring, "stock-entry"),
		).toBe("CDK：TEST-RESTOCK-001\n充值地址：https://redeem.example/");

		const second = await request("POST", payload());
		expect(await second.json()).toMatchObject({
			ok: true,
			idempotent: true,
			imported: 0,
			counts: { available: 1 },
		});
		expect(
			await db
				.prepare("SELECT COUNT(*) AS total FROM stock_entries")
				.first<{ total: number }>(),
		).toEqual({ total: 1 });
	});

	it("rejects a missing recharge URL and conflicting request reference", async () => {
		const missing = await request("POST", {
			...payload(),
			requestRef: "RESTOCK-TEST-0002",
			usageUrl: "",
		});
		expect(missing.status).toBe(400);
		expect(await missing.json()).toEqual({
			ok: false,
			error: "inventory_usage_url_required",
		});

		await request("POST", payload());
		const duplicate = await request("POST", {
			...payload(),
			requestRef: "RESTOCK-TEST-0003",
		});
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toEqual({
			ok: false,
			error: "restock_duplicate_inventory",
		});

		const conflict = await request("POST", {
			...payload(),
			secrets: ["TEST-RESTOCK-OTHER"],
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({
			ok: false,
			error: "restock_request_conflict",
		});
	});

	it("returns only aggregate stock counts", async () => {
		await request("POST", payload());
		const response = await request("GET");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			ok: true,
			component: {
				id: componentId,
				productName: "Product",
				itemName: "Pro 20X iOS",
				supplierBound: true,
			},
			counts: { available: 1, reserved: 0, delivered: 0, disabled: 0 },
		});
		expect(JSON.stringify(body)).not.toContain("TEST-RESTOCK-001");
	});

	function request(method: "GET" | "POST", body?: unknown) {
		const url = new URL("https://shop.example/api/ops/restock");
		if (method === "GET") url.searchParams.set("componentId", componentId);
		return handleRestockApiRequest(
			new Request(url, {
				method,
				body: body === undefined ? undefined : JSON.stringify(body),
				headers: {
					Authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
			}),
			{ DB: db, RESTOCK_API_TOKEN: token },
		);
	}
});

function payload() {
	return {
		requestRef,
		componentId,
		secrets: ["TEST-RESTOCK-001"],
		usageUrl: "https://redeem.example/",
		note: "test",
		source: "86",
	};
}

async function seed(db: D1Database) {
	await db.batch([
		db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1)`,
			)
			.bind(JSON.stringify(keyring)),
		db.prepare(
			`INSERT INTO products (id, name, product_type, status, created_at, updated_at)
			 VALUES ('00000000-0000-4000-8000-000000000001', 'Product', 'stock', 'active', 1, 1)`,
		),
		db
			.prepare(
				`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, supplier_status, currency,
			  currency_decimals, price_minor, enabled, created_at, updated_at)
			 VALUES (?, '00000000-0000-4000-8000-000000000001', 'Pro 20X iOS',
			  'supplier', 'available', 'CNY', 2, '120000', 1, 1, 1)`,
			)
			.bind(componentId),
		db.prepare(
			`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version, currency,
			  currency_decimals, name, credentials_encrypted, credentials_revision,
			  credential_fingerprint, health_status, enabled, created_at, updated_at)
			 VALUES ('account', 'shared_stock', 'https://supplier.example',
			  'https://supplier.example', '1', 'CNY', 2, 'Supplier', 'encrypted', 1,
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
			  'remote-product', 'remote-sku', 'Remote Product', 'Remote SKU', '100000',
			  '130000', 0, 'active', 1, 1, 1)`,
			)
			.bind(componentId),
	]);
}
