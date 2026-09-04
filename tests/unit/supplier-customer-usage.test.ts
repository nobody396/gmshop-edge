import { describe, expect, it } from "vitest";
import { resolveSupplierUsageUrl } from "#/features/suppliers/customer-usage";

const identity = {
	provider: "shared_stock",
	normalizedApiOrigin: "https://supplier.example",
	upstreamSkuId: "SKU-1",
};
const guide = {
	provider: "shared_stock",
	origin: "https://supplier.example",
	skuId: "SKU-1",
	url: "https://redeem.example/use",
};
const policy = { supplierUsageGuide: guide };
describe("supplier customer usage entry", () => {
	it("uses a verified guide only for the matching supplier and SKU", () => {
		expect(
			resolveSupplierUsageUrl(JSON.stringify(policy), JSON.stringify(identity)),
		).toBe(guide.url);
		for (const change of [
			{ provider: "acg" },
			{ normalizedApiOrigin: "https://other.example" },
			{ upstreamSkuId: "SKU-2" },
		])
			expect(
				resolveSupplierUsageUrl(policy, { ...identity, ...change }),
			).toBeNull();
	});
	it("keeps a paid-order snapshot stable instead of following later catalog changes", () => {
		expect(
			resolveSupplierUsageUrl(policy, {
				...identity,
				customerUsageUrl: "https://original.example/use",
			}),
		).toBe("https://original.example/use");
		expect(
			resolveSupplierUsageUrl(policy, { ...identity, customerUsageUrl: null }),
		).toBeNull();
	});
	it.each([
		"javascript:alert(1)",
		"http://redeem.example/use",
		"https://user:password@redeem.example/use",
		"https://redeem.example/use?api_key=private",
	])("rejects unsafe configured entry %s", (url) => {
		expect(
			resolveSupplierUsageUrl(
				{ supplierUsageGuide: { ...guide, url } },
				identity,
			),
		).toBeNull();
	});
	it("does not guess from a payment URL, malformed policy, or missing supplier identity", () => {
		expect(
			resolveSupplierUsageUrl(
				{},
				{ ...identity, url: "https://pay.example/checkout" },
			),
		).toBeNull();
		expect(resolveSupplierUsageUrl("invalid", identity)).toBeNull();
		expect(resolveSupplierUsageUrl(policy, null)).toBeNull();
	});
});
