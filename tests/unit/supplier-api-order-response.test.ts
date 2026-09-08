import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { describe, expect, it, vi } from "vitest";
import { applyMigrations } from "../integration/migrations";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { createSupplierApiOrder } from "#/features/supplier-api/server/orders";

describe("supplier API order response", () => {
	it("queries and returns immutable amount metadata on replay", async () => {
		const miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: "supplier-api-order-response" },
		});
		try {
			const db = await miniflare.getD1Database("DB");
			await applyMigrations(db);
			const input = {
				skuId: "sku-1",
				quantity: 1,
				downstreamOrderNo: "DJ-ORDER-1",
				callbackUrl: null,
				traceId: "trace-1",
			};
			const requestDigest = createHash("sha256")
				.update(JSON.stringify(input))
				.digest("hex");
			const now = Date.now();
			await db.batch([
				db
					.prepare(
						`INSERT INTO users
						 (id, name, email, email_verified, preferred_locale, enabled,
						  balance_minor, balance_version, role_ids, created_at, updated_at)
						 VALUES ('user-1', 'Buyer', 'buyer@example.com', 1, 'zh-CN', 1,
						  '0', 1, '[]', ?, ?)`,
					)
					.bind(now, now),
				db
					.prepare(
						`INSERT INTO shop_orders
						 (id, order_number, user_id, locale, status, currency,
						  currency_decimals, subtotal_minor, discount_minor, total_minor,
						  paid_minor, version, expires_at, created_at, updated_at)
						 VALUES ('shop-order-1', 'APIORDER1', 'user-1', 'zh-CN', 'completed',
						  'CNY', 2, '110', '0', '110', '110', 1, ?, ?, ?)`,
					)
					.bind(now + 900_000, now, now),
				db
					.prepare(
						`INSERT INTO supplier_api_keys
						 (id, user_id, name, key_id, secret_encrypted, secret_revision,
						  created_at, updated_at)
						 VALUES ('key-row-1', 'user-1', 'test', 'key-1', 'unused', 1, ?, ?)`,
					)
					.bind(now, now),
				db
					.prepare(
						`INSERT INTO supplier_api_orders
						 (id, shop_order_id, user_id, api_key_id, downstream_order_no,
						  request_digest, state, created_at, updated_at)
						 VALUES ('supplier-order-1', 'shop-order-1', 'user-1', 'key-row-1',
						  'DJ-ORDER-1', ?, 'processing', ?, ?)`,
					)
					.bind(requestDigest, now, now),
			]);

			await expect(
				createSupplierApiOrder(
					db,
					{
						userId: "user-1",
						keyId: "key-1",
						keyRowId: "key-row-1",
						allowedCallbackOrigin: null,
					},
					input,
				),
			).resolves.toEqual({
				ok: true,
				order_id: "supplier-order-1",
				status: "processing",
				amount_minor: "110",
				currency: "CNY",
				currency_decimals: 2,
			});
		} finally {
			await miniflare.dispose();
		}
	});
});
