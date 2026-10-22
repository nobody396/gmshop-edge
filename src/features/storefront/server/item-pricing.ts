import { z } from "zod";
import type {
	CustomerPriceStep,
	VolumeStep,
} from "#/features/storefront/volume-pricing";

export type ItemPricing = {
	volumeSteps: VolumeStep[];
	customerSteps: CustomerPriceStep[];
};

const channelPricesSchema = z.record(z.string(), z.string().regex(/^\d+$/));

/** Public volume steps for these items, plus this customer's own prices when signed in. */
export async function loadItemPricing(
	db: D1Database,
	sellableItemIds: readonly string[],
	userId?: string | null,
) {
	const ids = [...new Set(sellableItemIds)];
	const pricing = new Map<string, ItemPricing>(
		ids.map((id) => [id, { volumeSteps: [], customerSteps: [] }]),
	);
	if (ids.length === 0) return pricing;
	const placeholders = ids.map(() => "?").join(", ");
	const statements = [
		db
			.prepare(
				`SELECT sellable_item_id, min_quantity, discount_minor
				 FROM sellable_item_volume_prices
				 WHERE sellable_item_id IN (${placeholders})
				 ORDER BY sellable_item_id, min_quantity`,
			)
			.bind(...ids),
	];
	if (userId)
		statements.push(
			db
				.prepare(
					`SELECT sellable_item_id, min_quantity, price_minor, channel_prices_json
					 FROM customer_item_prices
					 WHERE user_id = ? AND sellable_item_id IN (${placeholders})
					 ORDER BY sellable_item_id, min_quantity`,
				)
				.bind(userId, ...ids),
		);
	const [volume, customer] = await db.batch(statements);
	for (const row of (volume?.results ?? []) as Array<{
		sellable_item_id: string;
		min_quantity: number;
		discount_minor: string;
	}>)
		pricing.get(row.sellable_item_id)?.volumeSteps.push({
			minQuantity: Number(row.min_quantity),
			discountMinor: row.discount_minor,
		});
	for (const row of (customer?.results ?? []) as Array<{
		sellable_item_id: string;
		min_quantity: number;
		price_minor: string;
		channel_prices_json: string;
	}>) {
		let channelPrices: Record<string, string> = {};
		try {
			channelPrices = channelPricesSchema.parse(
				JSON.parse(row.channel_prices_json),
			);
		} catch {
			// A malformed override falls back to the base price plus the usual difference.
		}
		pricing.get(row.sellable_item_id)?.customerSteps.push({
			minQuantity: Number(row.min_quantity),
			priceMinor: row.price_minor,
			channelPrices,
		});
	}
	return pricing;
}
