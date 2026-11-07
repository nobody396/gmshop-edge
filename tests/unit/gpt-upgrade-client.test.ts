import { describe, expect, it } from "vitest";
import { upgradeQuoteTokenSchema } from "#/features/gpt-upgrade/schema";
import { upgradePaidResponseSchema } from "#/features/gpt-upgrade/server/client";
import { requestWarehouse } from "#/features/redeem-warehouse/server/warehouse-client";

describe("upgrade warehouse protocol", () => {
	it.each([
		"upgrade.quote_already_paid",
		"upgrade.amount_mismatch",
	])("preserves the terminal 409 code %s", async (code) => {
		await expect(
			requestWarehouse(
				"fixture-token",
				"/api/internal/upgrade/paid",
				{},
				async () =>
					Response.json(
						{ success: false, code, msg: "fixture" },
						{ status: 409 },
					),
			),
		).rejects.toMatchObject({ code: `redeem_warehouse_http_409_${code}` });
	});
	it("rejects a status link outside the fixed redemption origin or path", () => {
		const data = {
			upgrade_id: "aaaa0000-0000-4000-8000-000000000001",
			state: "queued",
			status_url: "https://evil.example/upgrade/status/abc",
		};
		expect(
			upgradePaidResponseSchema.safeParse({ success: true, data }).success,
		).toBe(false);
		expect(
			upgradePaidResponseSchema.safeParse({
				success: true,
				data: {
					...data,
					status_url: "https://redeem.laoshirenvip.com/upgrade/status/abc",
				},
			}).success,
		).toBe(true);
	});
	it("accepts exactly 43 base64url token characters", () => {
		expect(upgradeQuoteTokenSchema.safeParse("A".repeat(43)).success).toBe(
			true,
		);
		for (const token of ["A".repeat(42), "A".repeat(44), "/".repeat(43)])
			expect(upgradeQuoteTokenSchema.safeParse(token).success).toBe(false);
	});
});
