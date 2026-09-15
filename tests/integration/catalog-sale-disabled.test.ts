import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	setProductSaleDisabled,
	setSellableItemSaleDisabled,
} from "#/features/catalog/server/editor";
import {
	loadCartSellableItem,
	presentCart,
} from "#/features/storefront/server/cart";
import { createMultiStoreOrder } from "#/features/storefront/server/multi-order";
import { selectStorefrontProductRow } from "#/features/storefront/server/product-query";
import { listSupplierCatalog } from "#/features/supplier-api/server/catalog";
import { applyMigrations } from "./migrations";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const productId = "11111111-1111-4111-8111-111111111111";
const sellableItemId = "22222222-2222-4222-8222-222222222222";
const adminId = "33333333-3333-4333-8333-333333333333";

describe("catalog sale-disabled state", { timeout: 30_000 }, () => {
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

	it("keeps a sale-disabled product and its inventory visible while rejecting every new order", async () => {
		const result = await setProductSaleDisabled(context(db), {
			productId,
			expectedRevision: 1,
			disabled: true,
		});
		expect(result).toMatchObject({ revision: 2, saleDisabled: true });

		const product = await selectStorefrontProductRow(db, productId);
		expect(product).toMatchObject({ sale_disabled: 1 });
		const supplierCatalog = await listSupplierCatalog(db, {
			page: 1,
			pageSize: 10,
		});
		expect(supplierCatalog.items[0]).toMatchObject({
			id: productId,
			sale_disabled: true,
			skus: [
				{
					id: sellableItemId,
					stock_quantity: 1,
					sale_disabled: true,
				},
			],
		});
		await expect(loadCartSellableItem(db, sellableItemId)).resolves.toBeNull();
		await expect(presentCart(db, "customer")).resolves.toMatchObject({
			items: [{ sellableItemId, availableStock: 1, issues: ["sale_disabled"] }],
		});
		await expect(
			createOrder(db, "product-disabled-order"),
		).rejects.toMatchObject({ code: "sellable_item_unavailable" });

		const audit = await db
			.prepare(
				"SELECT action FROM audit_logs WHERE target_id = ? ORDER BY created_at DESC LIMIT 1",
			)
			.bind(productId)
			.first<{ action: string }>();
		expect(audit?.action).toBe("product.sale_disabled");
	});

	it("keeps an individually sale-disabled SKU visible without disabling its product", async () => {
		await expect(
			setSellableItemSaleDisabled(context(db), {
				productId,
				sellableItemId,
				expectedRevision: 1,
				disabled: true,
			}),
		).resolves.toMatchObject({ revision: 2, saleDisabled: true });

		await expect(
			selectStorefrontProductRow(db, productId),
		).resolves.not.toBeNull();
		const supplierCatalog = await listSupplierCatalog(db, {
			page: 1,
			pageSize: 10,
		});
		expect(supplierCatalog.items[0]).toMatchObject({
			sale_disabled: false,
			skus: [
				{
					id: sellableItemId,
					stock_quantity: 1,
					sale_disabled: true,
				},
			],
		});
		await expect(loadCartSellableItem(db, sellableItemId)).resolves.toBeNull();
		await expect(presentCart(db, "customer")).resolves.toMatchObject({
			items: [{ sellableItemId, availableStock: 1, issues: ["sale_disabled"] }],
		});
		await expect(createOrder(db, "sku-disabled-order")).rejects.toMatchObject({
			code: "sellable_item_unavailable",
		});
	});

	it("does not allow the product-level control to create a hidden sale state", async () => {
		await db
			.prepare("UPDATE products SET status = 'draft' WHERE id = ?")
			.bind(productId)
			.run();
		await expect(
			setProductSaleDisabled(context(db), {
				productId,
				expectedRevision: 1,
				disabled: true,
			}),
		).rejects.toMatchObject({ code: "product_not_active" });
		const product = await db
			.prepare("SELECT revision, sale_disabled FROM products WHERE id = ?")
			.bind(productId)
			.first<{ revision: number; sale_disabled: number }>();
		expect(product).toEqual({ revision: 1, sale_disabled: 0 });
	});
});

function context(db: D1Database) {
	return {
		db: { $client: db },
		currentUser: { id: adminId },
		request: new Request("https://gmshop.example/admin/products"),
	} as never;
}

function createOrder(db: D1Database, idempotencyKey: string) {
	return createMultiStoreOrder(
		db,
		{
			email: "buyer@example.com",
			couponCode: "",
			idempotencyKey,
			customerNote: "",
			commerceSessionId: null,
			locale: "zh-CN",
			items: [
				{
					sellableItemId,
					quantity: 1,
					inputValues: {},
					renewedFromEntitlementId: null,
				},
			],
		},
		{},
	);
}

async function seed(db: D1Database) {
	await db.batch([
		db
			.prepare(
				`INSERT INTO users
				 (id, name, email, email_verified, enabled, created_at, updated_at)
				 VALUES (?, 'Admin', 'admin@example.com', 1, 1, 1, 1),
				        ('customer', 'Customer', 'customer@example.com', 1, 1, 1, 1)`,
			)
			.bind(adminId),
		db
			.prepare(
				`INSERT INTO products
				 (id, name, product_type, status, revision, created_at, updated_at)
				 VALUES (?, 'Visible product', 'stock', 'active', 1, 1, 1)`,
			)
			.bind(productId),
		db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, currency, currency_decimals, price_minor,
				  fulfillment_source, minimum_quantity, maximum_quantity, enabled,
				  created_at, updated_at)
				 VALUES (?, ?, 'Visible SKU', 'USD', 2, '1000', 'local', 1, 1, 1, 1, 1)`,
			)
			.bind(sellableItemId, productId),
		db
			.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version,
				  content_fingerprint, content_mask, status, created_at, updated_at)
				 VALUES ('stock', ?, 'ciphertext', 1, 'fingerprint', '••••', 'available', 1, 1)`,
			)
			.bind(sellableItemId),
		db
			.prepare(
				`INSERT INTO supplier_export_listings
				 (id, sellable_item_id, price_minor, currency, currency_decimals,
				  enabled, created_at, updated_at)
				 VALUES ('listing', ?, '900', 'USD', 2, 1, 1, 1)`,
			)
			.bind(sellableItemId),
		db
			.prepare(
				`INSERT INTO shopping_carts
				 (id, user_id, items_json, version, expires_at, created_at, updated_at)
				 VALUES ('cart', 'customer', ?, 1, ?, 1, 1)`,
			)
			.bind(
				JSON.stringify([{ sellableItemId, quantity: 1 }]),
				Date.now() + 86_400_000,
			),
	]);
}
