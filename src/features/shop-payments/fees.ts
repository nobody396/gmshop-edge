import { DomainError } from "#/lib/domain-error";

export function grossUpPaymentAmount(
	amountMinor: string,
	feeBps: number,
	fixedFeeMinor: string,
) {
	const amount = BigInt(amountMinor);
	const fixed = BigInt(fixedFeeMinor);
	if (feeBps < 0 || feeBps >= 10_000 || amount < 0n || fixed < 0n)
		throw new DomainError(
			"payment_channel_fee_invalid",
			500,
			"Payment channel fee configuration is invalid",
		);
	const numerator = (amount + fixed) * 10_000n;
	const denominator = BigInt(10_000 - feeBps);
	return ((numerator + denominator - 1n) / denominator).toString();
}

export function paymentSurchargeAmount(
	amountMinor: string,
	feeBps: number,
	fixedFeeMinor: string,
) {
	return (
		BigInt(grossUpPaymentAmount(amountMinor, feeBps, fixedFeeMinor)) -
		BigInt(amountMinor)
	).toString();
}
