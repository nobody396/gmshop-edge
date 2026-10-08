import { describe, expect, it } from "vitest";
import { pricePromotion } from "#/features/promotions/pricing";

describe("promotion pricing", () => {
	it("splits the capped order budget instead of granting eight yuan per item", () => {
		expect(
			pricePromotion("referral", [
				{ id: "a", budgetMinor: "800", subtotalMinor: "108000", quantity: 1 },
				{ id: "b", budgetMinor: "800", subtotalMinor: "140000", quantity: 1 },
			]),
		).toEqual({
			discountMinor: "400",
			rewardMinor: "400",
			lines: [
				{ id: "a", discountMinor: "200", rewardMinor: "200" },
				{ id: "b", discountMinor: "200", rewardMinor: "200" },
			],
		});
	});
});

it("gives recall customers the budget without an inviter payment", () => {
	expect(
		pricePromotion("recall", [
			{ id: "one", budgetMinor: "800", subtotalMinor: "108000", quantity: 1 },
		]),
	).toEqual({
		discountMinor: "800",
		rewardMinor: "0",
		lines: [{ id: "one", discountMinor: "800", rewardMinor: "0" }],
	});
});
it("does not automatically upgrade rewards when a cheap-tier basket exceeds a thousand yuan", () => {
	expect(
		pricePromotion("referral", [
			{ id: "one", budgetMinor: "200", subtotalMinor: "200000", quantity: 1 },
		]).discountMinor,
	).toBe("100");
});
it("keeps excluded SKUs excluded", () => {
	expect(
		pricePromotion("referral", [
			{ id: "one", budgetMinor: "0", subtotalMinor: "5000", quantity: 1 },
		]).rewardMinor,
	).toBe("0");
});
it("caps every 4-line tier combination and preserves exact line allocations", () => {
	for (const a of ["0", "100", "200", "400", "800"])
		for (const b of ["0", "100", "200", "400", "800"])
			for (const c of ["0", "100", "200", "400", "800"])
				for (const d of ["0", "100", "200", "400", "800"])
					for (const purpose of ["referral", "recall"] as const) {
						const result = pricePromotion(
							purpose,
							[a, b, c, d].map((budgetMinor, index) => ({
								id: String(index),
								budgetMinor,
								subtotalMinor: "400000",
								quantity: 1,
							})),
						);
						expect(
							BigInt(result.discountMinor) + BigInt(result.rewardMinor),
						).toBeLessThanOrEqual(800n);
						expect(
							result.lines.reduce((s, l) => s + BigInt(l.discountMinor), 0n),
						).toBe(BigInt(result.discountMinor));
						expect(
							result.lines.reduce((s, l) => s + BigInt(l.rewardMinor), 0n),
						).toBe(BigInt(result.rewardMinor));
					}
});
