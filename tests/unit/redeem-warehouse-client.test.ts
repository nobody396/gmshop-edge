import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requestWarehouse } from "#/features/redeem-warehouse/server/admin";

describe("redeem warehouse client", () => {
	it("keeps the fixed-layout inventory page vertically scrollable", () => {
		const source = readFileSync(
			resolve("src/features/redeem-warehouse/pages/admin.tsx"),
			"utf8",
		);
		expect(source).toContain(
			"flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain pb-6",
		);
	});

	it("sends the token only in the authorization header", async () => {
		const fetcher = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe(
					"https://redeem.laoshirenvip.com/api/internal/inventory/import",
				);
				expect(init?.headers).toMatchObject({
					Authorization: "Bearer test-token",
				});
				expect(init?.body).toBe('{"sku":"GPT_PLUS_IOS"}');
				return Response.json({ success: true, data: [] });
			},
		);
		await expect(
			requestWarehouse(
				"test-token",
				"/api/internal/inventory/import",
				{ method: "POST", body: '{"sku":"GPT_PLUS_IOS"}' },
				fetcher as typeof fetch,
			),
		).resolves.toEqual({ success: true, data: [] });
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("maps an upstream failure to one redacted domain error", async () => {
		const fetcher = vi.fn(async () =>
			Response.json(
				{ success: false, secret: "must-not-surface" },
				{ status: 500 },
			),
		);
		await expect(
			requestWarehouse(
				"test-token",
				"/api/internal/inventory/summary",
				{},
				fetcher as typeof fetch,
			),
		).rejects.toMatchObject({
			code: "redeem_warehouse_request_failed",
			status: 502,
		});
	});
});
