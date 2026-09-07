import { describe, expect, it } from "vitest";
import { formatInventoryDelivery } from "#/features/catalog/server/inventory-secrets";

describe("inventory delivery format", () => {
	it("keeps a card and its redemption URL in one allocated stock entry", () => {
		expect(
			formatInventoryDelivery("CARD-123", "https://redeem.example/path"),
		).toBe("CDK：CARD-123\n充值地址：https://redeem.example/path");
	});

	it("rejects a supplier-backed CDK without its recharge URL", () => {
		expect(() => formatInventoryDelivery("CARD-123", null, true)).toThrowError(
			expect.objectContaining({ code: "inventory_usage_url_required" }),
		);
	});
});
