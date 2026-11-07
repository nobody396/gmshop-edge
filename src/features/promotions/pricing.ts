import { DomainError } from "#/lib/domain-error";

export type PromotionPurpose = "referral" | "recall";
export const promotionBudgets = ["0", "100", "200", "400", "800"] as const;
export const promotionCapMinor = 800n;
/** Invitation split (owner 2026-11-07, plan B): the friend saves 30%, the referrer earns 70%. */
export const referralFriendShareBps = 3_000n;

/** Friend discount and referrer reward for one invitation budget, CNY cents. */
export function splitReferralBudget(budgetMinor: bigint) {
	const discount = (budgetMinor * referralFriendShareBps) / 10_000n;
	return { discount, reward: budgetMinor - discount };
}

/**
 * All amounts are CNY cents. Recall uses the explicit per-SKU tier with the ¥8
 * order cap. Referral uses the margin-derived per-SKU budget (any whole cents,
 * no order cap) split 30% friend discount / 70% referrer reward.
 */
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
			(purpose === "recall"
				? !promotionBudgets.some((value) => value === item.budgetMinor)
				: !/^\d+$/.test(item.budgetMinor)) ||
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
		return { id: item.id, budget };
	});
	if (purpose === "referral") {
		const lines = rows.map((row) => {
			const split = splitReferralBudget(row.budget);
			return {
				id: row.id,
				discountMinor: split.discount.toString(),
				rewardMinor: split.reward.toString(),
			};
		});
		const sum = (key: "discountMinor" | "rewardMinor") =>
			lines.reduce((total, line) => total + BigInt(line[key]), 0n).toString();
		return {
			discountMinor: sum("discountMinor"),
			rewardMinor: sum("rewardMinor"),
			lines,
		};
	}
	const sum = rows.reduce((total, row) => total + row.budget, 0n);
	const total = sum < promotionCapMinor ? sum : promotionCapMinor;
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
		rewardMinor: "0",
		lines: allocations.map((row) => ({
			id: row.id,
			discountMinor: row.amount.toString(),
			rewardMinor: "0",
		})),
	};
}
