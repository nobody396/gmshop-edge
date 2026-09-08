import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { createSupplierApiOrder } from "#/features/supplier-api/server/orders";

describe("supplier API order response", () => {
	it("returns immutable amount metadata on an idempotent replay", async () => {
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
		const first = vi.fn(async () => ({
			id: "supplier-order-1",
			request_digest: requestDigest,
			total_minor: "110",
			currency: "CNY",
			currency_decimals: 2,
		}));
		const db = {
			prepare: vi.fn(() => ({ bind: () => ({ first }) })),
		} as unknown as D1Database;

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
	});
});
