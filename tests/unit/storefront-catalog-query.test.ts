import { describe, expect, it } from "vitest";
import { storefrontCatalogQueryOptions } from "#/features/home/catalog-query";

describe("storefront catalog query options", () => {
	it("uses a canonical key when the URL contains unrelated search params", () => {
		const options = storefrontCatalogQueryOptions({
			search: "",
			tag: "",
			sort: "featured",
			locale: "zh-CN",
			campaign: "ignored",
		} as Parameters<typeof storefrontCatalogQueryOptions>[0]);

		expect(options.queryKey).toEqual([
			"storefront",
			"catalog",
			"zh-CN",
			"",
			"",
			"featured",
		]);
	});
});
