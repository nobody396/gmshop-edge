/**
 * Unit price of one checkout line. Pure, so the product and checkout pages
 * show exactly what the server charges.
 *
 * - A public volume step takes its discount off the channel's list price.
 * - A customer price is the base (USDT/balance) price agreed with that
 *   customer; another channel adds its usual difference from the base price,
 *   unless the agreement names a price for that channel.
 * - The customer always pays the lowest of the list, volume and customer price.
 */
export type VolumeStep = { minQuantity: number; discountMinor: string };
export type CustomerPriceStep = {
	minQuantity: number;
	priceMinor: string;
	channelPrices: Record<string, string>;
};
export type PriceSource = "list" | "volume" | "customer";

export function resolveUnitPrice(input: {
	/** The selected channel's price for this item (the base price without one). */
	listPriceMinor: string;
	/** The item's base price, which customer prices are agreed against. */
	basePriceMinor: string;
	channelId: string | null;
	quantity: number;
	volumeSteps: readonly VolumeStep[];
	customerSteps: readonly CustomerPriceStep[];
}): { unitPriceMinor: string; source: PriceSource } {
	const list = BigInt(input.listPriceMinor);
	let best = list;
	let source: PriceSource = "list";
	const volume = deepestStep(input.volumeSteps, input.quantity);
	if (volume) {
		const discount = BigInt(volume.discountMinor);
		if (discount > 0n && discount < list && list - discount < best) {
			best = list - discount;
			source = "volume";
		}
	}
	const customer = deepestStep(input.customerSteps, input.quantity);
	if (customer) {
		const named = input.channelId
			? customer.channelPrices[input.channelId]
			: undefined;
		const price = named
			? BigInt(named)
			: BigInt(customer.priceMinor) + (list - BigInt(input.basePriceMinor));
		if (price > 0n && price < best) {
			best = price;
			source = "customer";
		}
	}
	return { unitPriceMinor: best.toString(), source };
}

function deepestStep<T extends { minQuantity: number }>(
	steps: readonly T[],
	quantity: number,
) {
	let found: T | null = null;
	for (const step of steps)
		if (
			quantity >= step.minQuantity &&
			(!found || step.minQuantity > found.minQuantity)
		)
			found = step;
	return found;
}
