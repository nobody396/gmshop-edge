import {
	convertByRate,
	decimalPlaces,
	decimalToUnits,
	divideByRate,
	unitsToDecimal,
} from "#/lib/money";
import { currencyDecimals, minorToDecimal } from "#/lib/units";

export const exchangeRatePattern =
	/^(?:0\.(?:0*?[1-9]\d*)|[1-9]\d*(?:\.\d+)?)$/;

/**
 * Divisor for paying in the base currency of a stored pair. Dividing by the
 * adjusted rate would turn a markup into a discount, so the adjustment is
 * applied to the raw rate inversely: raw * 10000 / (10000 + bps), rounded
 * down to 12 extra places so the payer never pays less than intended.
 */
export function inverseAdjustedRate(rawRate: string, adjustmentBps: number) {
	if (!exchangeRatePattern.test(rawRate))
		throw new TypeError("Invalid exchange rate");
	if (adjustmentBps <= -10_000 || adjustmentBps > 100_000)
		throw new RangeError(
			"Exchange-rate adjustment is outside the supported range",
		);
	const decimals = decimalPlaces(rawRate);
	const units =
		(decimalToUnits(rawRate, decimals) * 10_000n * 10n ** 12n) /
		BigInt(10_000 + adjustmentBps);
	if (units <= 0n) throw new RangeError("Exchange rate is too small");
	return unitsToDecimal(units, decimals + 12);
}

export function applyRateAdjustment(rate: string, adjustmentBps: number) {
	if (!exchangeRatePattern.test(rate))
		throw new TypeError("Invalid exchange rate");
	if (adjustmentBps <= -10_000 || adjustmentBps > 100_000)
		throw new RangeError(
			"Exchange-rate adjustment is outside the supported range",
		);
	const decimals = decimalPlaces(rate);
	const units = decimalToUnits(rate, decimals);
	return unitsToDecimal(units * BigInt(10_000 + adjustmentBps), decimals + 4);
}

export function convertMinorAmount(input: {
	amountMinor: string;
	fromCurrency: string;
	fromDecimals: number;
	toCurrency: string;
	rate: string;
	direction: "multiply" | "divide";
}) {
	const outputDecimals = currencyDecimals(input.toCurrency);
	const amount = minorToDecimal(input.amountMinor, input.fromDecimals);
	const rateDecimals = decimalPlaces(input.rate);
	const converted =
		input.direction === "multiply"
			? convertByRate(
					amount,
					input.fromDecimals,
					input.rate,
					rateDecimals,
					outputDecimals,
				)
			: divideByRate(
					amount,
					input.fromDecimals,
					input.rate,
					rateDecimals,
					outputDecimals,
				);
	return {
		amountMinor: decimalToUnits(converted, outputDecimals).toString(),
		currency: input.toCurrency.toUpperCase(),
		currencyDecimals: outputDecimals,
	};
}
