import { describe, expect, it } from "vitest";
import { formatInventoryDelivery } from "#/features/catalog/server/inventory-secrets";

describe("inventory delivery format", () => {
	it("keeps a card and its redemption URL in one allocated stock entry", () => {
		expect(
			formatInventoryDelivery("CARD-123", "https://redeem.example/path"),
		).toBe("CDK：CARD-123\n兑换地址：https://redeem.example/path");
	});
});
