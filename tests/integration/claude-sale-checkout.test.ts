import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshClaudeSaleCapacity } from "#/features/redeem-warehouse/server/sale-capacity";
import { expireStoreOrders } from "#/features/shop-orders/server/expiration";
import { transitionShopOrder } from "#/features/shop-orders/server/transition";
import { completeWalletStoreOrder } from "#/features/shop-payments/server/service";
import { createMultiStoreOrder } from "#/features/storefront/server/multi-order";
import { storefrontStockExpression } from "#/features/storefront/server/stock-availability";
import { listSupplierCatalog } from "#/features/supplier-api/server/catalog";
import { createSupplierApiOrder } from "#/features/supplier-api/server/orders";
import { encryptSecret } from "#/lib/secrets";
import { applyMigrations } from "./migrations";

const item = "33333333-3333-4333-8333-333333333333",
	product = "22222222-2222-4222-8222-222222222222",
	user = "11111111-1111-4111-8111-111111111111";
const secret = "test-commerce-secret";
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function code(i: number) {
	return `claude-pro-ios-AAAA-BBBB-CCCC-AA${alphabet[Math.floor(i / 32)]}${alphabet[i % 32]}`;
}

describe("Claude checkout uses actual uncommitted upstream capacity", {
	timeout: 30_000,
}, () => {
	let mf: Miniflare, db: D1Database;
	let keys: number;
	let generated: number;
	let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
	beforeEach(async () => {
		keys = 5;
		generated = 100;
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		const token = await encryptSecret(
			"test-warehouse-token",
			secret,
			"redeem-warehouse-token",
		);
		await db.batch([
			db
				.prepare(
					"INSERT INTO products (id,name,product_type,status,created_at,updated_at) VALUES (?,'Claude','stock','active',1,1)",
				)
				.bind(product),
			db
				.prepare(
					"INSERT INTO product_sellable_items (id,product_id,name,currency,currency_decimals,price_minor,fulfillment_source,maximum_quantity,created_at,updated_at) VALUES (?,?,'Pro','CNY',2,'100','local',100,1,1)",
				)
				.bind(item, product),
			db
				.prepare(
					"INSERT INTO users (id,name,email,balance_minor,created_at,updated_at) VALUES (?,'Buyer','buyer@example.com','10000',1,1)",
				)
				.bind(user),
			db
				.prepare(
					"INSERT INTO supplier_api_keys (id,user_id,name,key_id,secret_encrypted,created_at,updated_at) VALUES ('key-row',?,'Test','test-key','not-used',1,1)",
				)
				.bind(user),
			db
				.prepare(
					"INSERT INTO supplier_export_listings (id,sellable_item_id,enabled,price_minor,currency,currency_decimals,created_at,updated_at) VALUES ('export-test',?,1,'100','CNY',2,1,1)",
				)
				.bind(item),
			...[
				["runtime.data_encryption_secret", secret],
				["integration.redeem_warehouse_token", token],
				["commerce.default_currency", "CNY"],
			].map(([key, value]) =>
				db
					.prepare(
						"INSERT INTO system_settings (key,value,is_secret,created_at,updated_at) VALUES (?,?,1,1,1)",
					)
					.bind(key, JSON.stringify(value)),
			),
			db
				.prepare(
					"INSERT INTO system_settings (key,value,is_secret,created_at,updated_at) VALUES ('integration.supply_console_map',?,0,1,1)",
				)
				.bind(JSON.stringify({ [item]: "CLAUDE_PRO_IOS" })),
		]);
		const entries = await Promise.all(
			Array.from({ length: 100 }, async (_, i) => ({
				id: `stock-${i}`,
				mask: code(i).slice(-4),
				cipher: await encryptSecret(
					`CDK：${code(i)}\n充值地址：https://redeem.lsrai.shop`,
					secret,
					"stock-entry",
				),
			})),
		);
		await db.batch(
			entries.map((e) =>
				db
					.prepare(
						"INSERT INTO stock_entries (id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status,created_at,updated_at,redeem_sku) VALUES (?,?,?,1,?,?,'available',1,1,'CLAUDE_PRO_IOS')",
					)
					.bind(e.id, item, e.cipher, e.id, e.mask),
			),
		);
		fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body ?? "{}"));
			if (url.endsWith("sale-capacity")) {
				const owed = body.code_hashes.length;
				return Response.json({
					success: true,
					data: {
						available: keys,
						outstanding: owed,
						sellable: Math.max(0, keys - owed),
					},
				});
			}
			if (url.endsWith("codes/batch"))
				return Response.json({
					success: true,
					data: {
						sku: "CLAUDE_PRO_IOS",
						count: body.count,
						codes: Array.from({ length: body.count }, () => code(generated++)),
					},
				});
			throw new Error("Unexpected external call");
		});
		vi.stubGlobal("fetch", fetcher);
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		await mf.dispose();
	});
	function checkout(quantity: number, key: string = crypto.randomUUID()) {
		return createMultiStoreOrder(
			db,
			{
				items: [{ sellableItemId: item, quantity, inputValues: {} }],
				email: "buyer@example.com",
				idempotencyKey: key,
				customerNote: "",
			},
			{ userId: user },
		);
	}
	async function stock() {
		return (
			await db
				.prepare(
					`SELECT ${storefrontStockExpression("p", "i")} AS count FROM product_sellable_items i JOIN products p ON p.id=i.product_id WHERE i.id=?`,
				)
				.bind(item)
				.first<{ count: number }>()
		)?.count;
	}
	it("the worked example leaves one after selling two plus two, independent of 100 preissued codes", async () => {
		await checkout(2);
		await checkout(2);
		expect(await stock()).toBe(1);
		const catalog = await listSupplierCatalog(db, { page: 1, pageSize: 10 });
		expect(catalog.items[0]?.skus[0]?.stock_quantity).toBe(1);
	});
	it("payment and replay do not reserve a second set of codes or decrement again", async () => {
		const first = await checkout(2, "same-order-key");
		await completeWalletStoreOrder(db, { orderId: first.id, userId: user });
		await completeWalletStoreOrder(db, { orderId: first.id, userId: user });
		expect((await checkout(2, "same-order-key")).duplicate).toBe(true);
		expect(await stock()).toBe(3);
		expect(
			(
				await db
					.prepare(
						"SELECT COUNT(*) AS n FROM stock_entries WHERE status='reserved'",
					)
					.first<{ n: number }>()
			)?.n,
		).toBe(2);
	});
	it("concurrent checkouts cannot oversell a shared pool", async () => {
		keys = 3;
		const results = await Promise.allSettled([checkout(2), checkout(2)]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(
			(
				await db
					.prepare("SELECT COUNT(*) AS n FROM shop_orders")
					.first<{ n: number }>()
			)?.n,
		).toBe(1);
		expect(
			(
				await db
					.prepare(
						"SELECT COUNT(*) AS n FROM stock_entries WHERE status='reserved'",
					)
					.first<{ n: number }>()
			)?.n,
		).toBe(2);
	});
	it("a small own-code pool is topped up on demand, not treated as the real limit", async () => {
		await db.prepare("DELETE FROM stock_entries WHERE id!='stock-0'").run();
		const created = await checkout(3);
		expect(created.status).toBe("pending_payment");
		expect(generated).toBe(102);
		expect(await stock()).toBe(2);
	});
	it("expired and cancelled unpaid orders release once, then read capacity afresh", async () => {
		const first = await checkout(2);
		await expireStoreOrders(db, first.expiresAt + 1);
		await expireStoreOrders(db, first.expiresAt + 1);
		await refreshClaudeSaleCapacity(db);
		expect(await stock()).toBe(5);
		const next = await checkout(2);
		await transitionShopOrder(db, {
			id: next.id,
			version: 1,
			toStatus: "cancelled",
			note: null,
			actorType: "customer",
			actorUserId: null,
		});
		await refreshClaudeSaleCapacity(db);
		expect(await stock()).toBe(5);
	});
	it("the agent API shares capacity with the main storefront and fails before charging", async () => {
		await checkout(4);
		const identity = {
			userId: user,
			keyId: "test-key",
			keyRowId: "key-row",
			allowedCallbackOrigin: null,
		};
		await expect(
			createSupplierApiOrder(db, identity, {
				skuId: item,
				quantity: 2,
				downstreamOrderNo: "agent-too-many",
			}),
		).rejects.toMatchObject({ code: "inventory_unavailable" });
		const sold = await createSupplierApiOrder(db, identity, {
			skuId: item,
			quantity: 1,
			downstreamOrderNo: "agent-last-one",
		});
		expect(sold.ok).toBe(true);
		await createSupplierApiOrder(db, identity, {
			skuId: item,
			quantity: 1,
			downstreamOrderNo: "agent-last-one",
		});
		expect(
			(
				await db
					.prepare("SELECT balance_minor FROM users WHERE id=?")
					.bind(user)
					.first<{ balance_minor: string }>()
			)?.balance_minor,
		).toBe("9900");
		expect(await stock()).toBe(0);
	});
	it("keeps paid-but-unallocated legacy orders in sale obligations", async () => {
		const first = await checkout(2);
		await db
			.prepare(
				"UPDATE stock_entries SET status='available',order_item_id=NULL,reserved_at=NULL WHERE order_item_id IN (SELECT id FROM shop_order_items WHERE order_id=?)",
			)
			.bind(first.id)
			.run();
		await db
			.prepare(
				"UPDATE shop_orders SET status='paid',paid_minor=total_minor WHERE id=?",
			)
			.bind(first.id)
			.run();
		const capacity = await refreshClaudeSaleCapacity(db);
		expect(capacity).toMatchObject({
			available: 5,
			outstanding: 2,
			sellable: 3,
		});
		expect(await stock()).toBe(3);
	});

	it("warehouse failure closes sales instead of falling back to the virtual code pool", async () => {
		fetcher.mockRejectedValue(new Error("offline"));
		await expect(checkout(1)).rejects.toMatchObject({
			code: "redeem_sale_capacity_unavailable",
		});
		expect(await stock()).toBe(0);
	});
});
