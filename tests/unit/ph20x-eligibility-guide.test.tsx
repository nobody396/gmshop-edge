import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("retired PH Pro eligibility gate", () => {
	it("does not render an eligibility link, guide, or upgrade-button check", () => {
		const source = readFileSync(
			"src/features/storefront/pages/product.tsx",
			"utf8",
		);
		expect(source).not.toContain("ph20x-eligibility");
		expect(source).not.toContain("Ph20xEligibilityGuide");
		expect(source).not.toContain("store_ph20x_eligibility");
		expect(source).toContain("ChatGptRegionGuide");
		expect(source).toContain("selectedItem");
	});
	it("removes the retired requirement in both locales", () => {
		for (const locale of ["en-US", "zh-CN"]) {
			const messages = JSON.parse(
				readFileSync(`messages/${locale}.json`, "utf8"),
			);
			expect(
				Object.keys(messages).filter((key) =>
					key.startsWith("store_ph20x_eligibility_"),
				),
			).toEqual([]);
		}
	});
});
