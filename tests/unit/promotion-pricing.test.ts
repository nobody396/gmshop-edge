import { describe, expect, it } from "vitest";
import {
	pricePromotion,
	splitReferralBudget,
} from "#/features/promotions/pricing";
import { referralBudgetFor } from "#/features/promotions/server/referral-budget";

describe("promotion pricing", () => {
	it("splits each invitation budget 30% friend / 70% referrer with no ¥8 order cap", () => {
		expect(
			pricePromotion("referral", [
				{ id: "a", budgetMinor: "1500", subtotalMinor: "108000", quantity: 1 },
				{ id: "b", budgetMinor: "3500", subtotalMinor: "137000", quantity: 1 },
			]),
		).toEqual({
			discountMinor: "1500",
			rewardMinor: "3500",
			lines: [
				{ id: "a", discountMinor: "450", rewardMinor: "1050" },
				{ id: "b", discountMinor: "1050", rewardMinor: "2450" },
			],
		});
	});

	it("multiplies by quantity and never exceeds the line price", () => {
		expect(
			pricePromotion("referral", [
				{ id: "a", budgetMinor: "300", subtotalMinor: "24000", quantity: 2 },
			]).discountMinor,
		).toBe("180");
		expect(
			pricePromotion("referral", [
				{ id: "a", budgetMinor: "5000", subtotalMinor: "1000", quantity: 1 },
			]),
		).toMatchObject({ discountMinor: "300", rewardMinor: "700" });
	});

	it("keeps excluded SKUs excluded and rejects malformed budgets", () => {
		expect(
			pricePromotion("referral", [
				{ id: "one", budgetMinor: "0", subtotalMinor: "5000", quantity: 1 },
			]).rewardMinor,
		).toBe("0");
		expect(() =>
			pricePromotion("referral", [
				{ id: "one", budgetMinor: "-1", subtotalMinor: "5000", quantity: 1 },
			]),
		).toThrow();
	});

	it("splits odd cents without losing any", () => {
		expect(splitReferralBudget(101n)).toEqual({ discount: 30n, reward: 71n });
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

it("caps every 4-line recall tier combination and preserves exact line allocations", () => {
	for (const a of ["0", "100", "200", "400", "800"])
		for (const b of ["0", "100", "200", "400", "800"])
			for (const c of ["0", "100", "200", "400", "800"])
				for (const d of ["0", "100", "200", "400", "800"]) {
					const result = pricePromotion(
						"recall",
						[a, b, c, d].map((budgetMinor, index) => ({
							id: String(index),
							budgetMinor,
							subtotalMinor: "400000",
							quantity: 1,
						})),
					);
					expect(BigInt(result.discountMinor)).toBeLessThanOrEqual(800n);
					expect(
						result.lines.reduce((s, l) => s + BigInt(l.discountMinor), 0n),
					).toBe(BigInt(result.discountMinor));
				}
});

it("rejects recall budgets outside the tiers", () => {
	expect(() =>
		pricePromotion("recall", [
			{ id: "one", budgetMinor: "1500", subtotalMinor: "108000", quantity: 1 },
		]),
	).toThrow();
});

describe("margin-derived invitation budget", () => {
	const realCost = (minor: bigint) => (minor * 1_0142n) / 1_0000n;
	const channels = (usdt: bigint, alipay: bigint) => [
		{ priceMinor: usdt, feeBps: 0n },
		{ priceMinor: alipay, feeBps: 160n },
	];

	it("takes 35% of the thinnest channel margin, rounded down to whole yuan", () => {
		// Pro 200 iOS: ¥1370 USDT / ¥1400 Alipay, cost ¥1250 → margin ~¥102 → ¥35.
		expect(
			referralBudgetFor({
				priceMinor: 137000n,
				costMinor: 125000n,
				participates: true,
				channels: channels(137000n, 140000n),
				realCost,
			}),
		).toBe(3500n);
		// Plus 菲区: ¥120 / ¥125, cost ¥110 → margin ~¥8.4 → ¥2.
		expect(
			referralBudgetFor({
				priceMinor: 12000n,
				costMinor: 11000n,
				participates: true,
				channels: channels(12000n, 12500n),
				realCost,
			}),
		).toBe(200n);
	});

	it("caps at 10% of price and is zero without participation, cost or margin", () => {
		expect(
			referralBudgetFor({
				priceMinor: 10000n,
				costMinor: 100n,
				participates: true,
				channels: channels(10000n, 10000n),
				realCost,
			}),
		).toBe(1000n);
		for (const input of [
			{ participates: false, costMinor: 1000n },
			{ participates: true, costMinor: null },
			{ participates: true, costMinor: 0n },
			{ participates: true, costMinor: 20000n },
		])
			expect(
				referralBudgetFor({
					priceMinor: 12000n,
					channels: channels(12000n, 12500n),
					realCost,
					...input,
				}),
			).toBe(0n);
	});
});
