import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const messages = (locale: "en-US" | "zh-CN") =>
	JSON.parse(
		readFileSync(
			new URL(`../../messages/${locale}.json`, import.meta.url),
			"utf8",
		),
	) as Record<string, string>;

describe("storefront customer copy boundary", () => {
	it("does not expose internal sourcing terminology", () => {
		const chinese = Object.entries(messages("zh-CN")).filter(([key]) =>
			key.startsWith("store_"),
		);
		const english = Object.entries(messages("en-US")).filter(([key]) =>
			key.startsWith("store_"),
		);

		for (const [key, value] of chinese)
			expect(value, key).not.toContain("上游");
		for (const [key, value] of english)
			expect(value, key).not.toMatch(/\b(?:upstream|supplier)\b/i);
	});
});
