import {
	grossUpPaymentAmount,
	paymentProcessingFeeAmount,
} from "#/features/shop-payments/fees";

/**
 * Limits and split payments for Alipay 订单码支付 (`alipay_qr`). A personal
 * Alipay account without a business licence may collect at most a fixed amount
 * per payment and per (Beijing) day; larger orders are paid in several parts.
 * Pure helpers shared by the checkout page and the server.
 */

export const splitPaymentProviders: ReadonlySet<string> = new Set([
	"alipay_qr",
]);

/** Split orders get this much payment time per part (capped below). */
export const splitPaymentMsPerPart = 15 * 60_000;
export const splitPaymentMaxExpiryMs = 2 * 60 * 60_000;

export type PaymentChannelLimits = {
	/** '0' = no single-payment limit. */
	perPaymentMaxMinor: string;
	splitEnabled: boolean;
	splitMaxParts: number;
	/** null = no daily limit; otherwise what can still be collected today. */
	dailyRemainingMinor: string | null;
};

export type PaymentLimitDecision =
	| { allowed: true; parts: number }
	| {
			allowed: false;
			reason: "per_payment_limit" | "split_parts_limit" | "daily_limit";
	  };

export function paymentLimitDecision(
	limits: PaymentChannelLimits,
	amountMinor: string | bigint,
	options: { allowSplit?: boolean } = {},
): PaymentLimitDecision {
	const amount = BigInt(amountMinor);
	if (
		limits.dailyRemainingMinor !== null &&
		amount > BigInt(limits.dailyRemainingMinor)
	)
		return { allowed: false, reason: "daily_limit" };
	const cap = BigInt(limits.perPaymentMaxMinor);
	if (cap === 0n || amount <= cap) return { allowed: true, parts: 1 };
	if (!limits.splitEnabled || options.allowSplit === false)
		return { allowed: false, reason: "per_payment_limit" };
	const parts = Number((amount + cap - 1n) / cap);
	return parts > limits.splitMaxParts
		? { allowed: false, reason: "split_parts_limit" }
		: { allowed: true, parts };
}

/**
 * Splits an amount into `ceil(amount / cap)` parts that differ by at most one
 * minor unit, larger parts first: 300000 → 150000+150000;
 * 400100 → 133367+133367+133366.
 */
export function splitPaymentAmount(amountMinor: string, capMinor: string) {
	const amount = BigInt(amountMinor);
	const cap = BigInt(capMinor);
	if (amount <= 0n || cap <= 0n) return [amount.toString()];
	const count = (amount + cap - 1n) / cap;
	const base = amount / count;
	const remainder = amount % count;
	return Array.from({ length: Number(count) }, (_, index) =>
		(base + (BigInt(index) < remainder ? 1n : 0n)).toString(),
	);
}

const beijingOffsetMs = 8 * 60 * 60_000;
const dayMs = 24 * 60 * 60_000;

/** Start (UTC ms) of the Beijing calendar day containing `now`. */
export function beijingDayStart(now: number) {
	return Math.floor((now + beijingOffsetMs) / dayMs) * dayMs - beijingOffsetMs;
}

/** Beijing calendar date (YYYY-MM-DD) of `now`; the daily-limit bucket. */
export function beijingDay(now: number) {
	return new Date(beijingDayStart(now) + beijingOffsetMs)
		.toISOString()
		.slice(0, 10);
}

/**
 * What the customer pays through a channel for `amountMinor` of goods. A
 * single payment is grossed up once; a split payment must cover the fee of
 * every part (each part pays its own fixed fee and rounds its own percentage),
 * so the total grows until total − Σ part fees ≥ amount. The checkout page and
 * the server use this same function.
 */
export function channelPaymentAmount(
	amountMinor: string,
	feeBps: number,
	fixedFeeMinor: string,
	splitCapMinor: string | null,
) {
	const amount = BigInt(amountMinor);
	let total = BigInt(grossUpPaymentAmount(amountMinor, feeBps, fixedFeeMinor));
	if (!splitCapMinor || BigInt(splitCapMinor) <= 0n || amount === 0n)
		return total.toString();
	for (let round = 0; round < 1_000; round += 1) {
		const fees = splitPaymentAmount(total.toString(), splitCapMinor).reduce(
			(sum, part) =>
				sum + BigInt(paymentProcessingFeeAmount(part, feeBps, fixedFeeMinor)),
			0n,
		);
		const shortfall = amount + fees - total;
		if (shortfall <= 0n) return total.toString();
		total += shortfall;
	}
	throw new Error("Split payment amount does not converge");
}

/** Split cap of checkout limits, or null when the channel never splits. */
export function limitsSplitCapMinor(limits: PaymentChannelLimits | null) {
	return limits?.splitEnabled && BigInt(limits.perPaymentMaxMinor) > 0n
		? limits.perPaymentMaxMinor
		: null;
}

export function splitOrderExpiry(
	currentExpiresAt: number,
	parts: number,
	now: number,
) {
	const target =
		now + Math.min(parts * splitPaymentMsPerPart, splitPaymentMaxExpiryMs);
	return Math.max(currentExpiresAt, target);
}
