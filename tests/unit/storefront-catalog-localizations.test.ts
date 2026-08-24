import { describe, expect, it } from "vitest";
import { localizeSellableItem } from "#/features/storefront/catalog-localizations";

const fallback = {
	name: "测试规格",
	policy: {
		delivery: "付款确认后人工处理",
		deliveryTime: "24小时内交付；可在订单页查看交付状态和内容",
		coverage: "覆盖规则",
		warranty: "质保规则",
		restrictions: "限制规则",
	},
};

describe("storefront catalog localizations", () => {
	it("keeps English delivery copy aligned with runtime manual fulfillment", () => {
		const item = localizeSellableItem(
			"983f6e73-061e-419d-a7d5-8ac5ec5648ab",
			"en-US",
			fallback,
			"manual",
		);

		expect(item.policy.delivery).toBe(
			"Manually processed after payment confirmation",
		);
		expect(item.policy.deliveryTime).toBe(
			"Delivered within 24 hours; view delivery status and contents on the order page",
		);
		expect(item.policy.coverage).toContain("Renewal is supported");
	});
});
