import { describe, expect, it } from "vitest";
import { orderedCategories } from "#/features/home/category-sidebar";

describe("home category sidebar order", () => {
	it("follows the fixed category order and puts unknown tags last", () => {
		const tags = [
			{ name: "接码", productCount: 6 },
			{ name: "Zeta", productCount: 1 },
			{ name: "OpenAI", productCount: 3 },
			{ name: "Anthropic", productCount: 3 },
			{ name: "开店赚钱", productCount: 2 },
		];
		expect(orderedCategories(tags).map((tag) => tag.name)).toEqual([
			"Anthropic",
			"OpenAI",
			"接码",
			"开店赚钱",
			"Zeta",
		]);
	});
});
