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
	it.each([
		"3小时内交付；可在订单页查看交付状态和内容",
		"6小时内交付；可在订单页查看交付状态和内容",
		"12小时内交付；可在订单页查看交付状态和内容",
		"24小时内交付；可在订单页查看交付状态和内容",
	])("standardizes English online-delivery timing", (deliveryTime) => {
		const item = localizeSellableItem(
			"983f6e73-061e-419d-a7d5-8ac5ec5648ab",
			"en-US",
			{
				...fallback,
				policy: { ...fallback.policy, deliveryTime },
			},
			"manual",
		);

		expect(item.policy.delivery).toBe(
			"Processed online after payment confirmation",
		);
		expect(item.policy.deliveryTime).toContain("1–30 minutes");
		expect(item.policy.deliveryTime).toContain("3 hours");
		expect(item.policy.coverage).toContain("Renewal is supported");
	});
});

it("uses dollar-tier names without retired qualification and matches standard $500 delivery", () => {
	const ph = localizeSellableItem(
		"0829de43-da22-420c-9866-38c83dd420f0",
		"en-US",
		fallback,
	);
	const cl = localizeSellableItem(
		"030582df-98c1-5b87-914d-28ddc606e163",
		"en-US",
		fallback,
	);
	expect(ph.name).toContain("$200");
	expect(ph.policy.restrictions).not.toMatch(
		/eligibility|Upgrade to Pro|clickable/i,
	);
	expect(cl.name).toContain("$500");
	expect(cl.policy.delivery).toBe(
		"Processed online after payment confirmation",
	);
	expect(cl.policy.deliveryTime).toBe(ph.policy.deliveryTime);
	expect(cl.policy.deliveryTime).toContain("1–30 minutes");
	expect(cl.policy.coverage).toContain("No active Go, Plus, or Pro");
});
