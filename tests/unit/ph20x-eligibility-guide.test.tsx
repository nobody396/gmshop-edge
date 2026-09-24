// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	Ph20xEligibilityGuide,
	ph20xNewSkuId,
} from "#/features/storefront/components/ph20x-eligibility-guide";

describe("PH 20X new-activation eligibility guide", () => {
	it("requires clickable upgrade, not merely the visible 20x option", () => {
		const html = renderToStaticMarkup(<Ph20xEligibilityGuide />);
		expect(html).toContain("black and clickable");
		expect(html).toContain("seeing the 20x option alone is not enough");
		expect(html).toContain("do not order");
		expect(html).toContain("does not apply to Philippines 20X renewals");
		expect(html).toContain("Do not pay on the official site");
		expect(html).toContain('target="_blank"');
		expect(html).toContain('class="h-auto w-full rounded-xl"');
		expect(html).not.toContain("object-cover");
	});
	it("only attaches to the exact selected new-activation SKU", () => {
		expect(ph20xNewSkuId).toBe("0829de43-da22-420c-9866-38c83dd420f0");
		const source = readFileSync(
			"src/features/storefront/pages/product.tsx",
			"utf8",
		);
		expect(source).toContain('href="#ph20x-eligibility"');
		expect(source).toMatch(
			/selectedItem\?\.id === ph20xNewSkuId \?\s*<Ph20xEligibilityGuide/,
		);
		const image = readFileSync("public/guides/chatgpt/ph20x-eligibility.png");
		expect(image.readUInt32BE(16)).toBe(1464);
		expect(image.readUInt32BE(20)).toBe(1844);
	});
});
