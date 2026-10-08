import { DomainError } from "#/lib/domain-error";

export type PromotionPurpose = "referral" | "recall";
export const promotionBudgets = ["0", "100", "200", "400", "800"] as const;
export const promotionCapMinor = 800n;

/** All amounts are CNY cents. Configuration is explicit per SKU, never inferred from checkout prices. */
export function pricePromotion(
	purpose: PromotionPurpose,
	items: readonly {
		id: string;
		budgetMinor: string;
		subtotalMinor: string;
		quantity: number;
	}[],
) {
	const rows = items.map((item) => {
		if (
			!promotionBudgets.some((value) => value === item.budgetMinor) ||
			!/^\d+$/.test(item.subtotalMinor) ||
			!Number.isSafeInteger(item.quantity) ||
			item.quantity < 1
		)
			throw new DomainError(
				"promotion_configuration_invalid",
				409,
				"Invalid promotion configuration",
			);
		const amount = BigInt(item.subtotalMinor);
		const requested = BigInt(item.budgetMinor) * BigInt(item.quantity);
		// Keep discounts within the eligible line's price and split referral budgets into equal cents.
		const budget = requested < amount ? requested : amount;
		return {
			id: item.id,
			budget: purpose === "referral" ? budget / 2n : budget,
		};
	});
	const sum = rows.reduce((total, row) => total + row.budget, 0n);
	const cap =
		purpose === "referral" ? promotionCapMinor / 2n : promotionCapMinor;
	const total = sum < cap ? sum : cap;
	const allocations = rows.map((row) => ({
		...row,
		amount: sum ? (total * row.budget) / sum : 0n,
		remainder: sum ? (total * row.budget) % sum : 0n,
	}));
	let remaining =
		total - allocations.reduce((amount, row) => amount + row.amount, 0n);
	for (const row of [...allocations].sort((a, b) =>
		a.remainder === b.remainder
			? a.id.localeCompare(b.id)
			: a.remainder > b.remainder
				? -1
				: 1,
	)) {
		if (remaining === 0n) break;
		row.amount += 1n;
		remaining -= 1n;
	}
	return {
		discountMinor: total.toString(),
		rewardMinor: purpose === "referral" ? total.toString() : "0",
		lines: allocations.map((row) => ({
			id: row.id,
			discountMinor: row.amount.toString(),
			rewardMinor: purpose === "referral" ? row.amount.toString() : "0",
		})),
	};
}
