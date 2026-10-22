import { resolveUnitPrice } from "#/features/storefront/volume-pricing";
import { loadItemPricing } from "./item-pricing";

/**
 * Unit prices a checkout will charge for these lines: `base` without a payment
 * channel (balance), and per channel for items that have a price on that
 * channel. Mirrors createMultiStoreOrder; prices are display-only here.
 */
export async function quoteUnitPrices(
	db: D1Database,
	items: readonly { id: string; quantity: number }[],
	userId: string | null,
) {
	const ids = [...new Set(items.map((item) => item.id))];
	const placeholders = ids.map(() => "?").join(", ");
	const [baseRows, channelRows] = await db.batch([
		db
			.prepare(
				`SELECT id, price_minor FROM product_sellable_items WHERE id IN (${placeholders})`,
			)
			.bind(...ids),
		db
			.prepare(
				`SELECT price.channel_id, price.sellable_item_id, price.price_minor
				 FROM sellable_item_channel_prices price
				 JOIN payment_channels channel ON channel.id = price.channel_id
				 WHERE price.enabled = 1 AND channel.enabled = 1
				  AND price.sellable_item_id IN (${placeholders})`,
			)
			.bind(...ids),
	]);
	const basePrices = new Map(
		(
			(baseRows?.results ?? []) as Array<{ id: string; price_minor: string }>
		).map((row) => [row.id, row.price_minor]),
	);
	const pricing = await loadItemPricing(db, ids, userId);
	const base: Record<string, string> = {};
	const channels: Record<string, Record<string, string>> = {};
	for (const item of items) {
		const basePrice = basePrices.get(item.id);
		const steps = pricing.get(item.id);
		if (!basePrice || !steps) continue;
		const resolve = (listPriceMinor: string, channelId: string | null) =>
			resolveUnitPrice({
				listPriceMinor,
				basePriceMinor: basePrice,
				channelId,
				quantity: item.quantity,
				volumeSteps: steps.volumeSteps,
				customerSteps: steps.customerSteps,
			}).unitPriceMinor;
		base[item.id] = resolve(basePrice, null);
		for (const row of (channelRows?.results ?? []) as Array<{
			channel_id: string;
			sellable_item_id: string;
			price_minor: string;
		}>) {
			if (row.sellable_item_id !== item.id) continue;
			channels[row.channel_id] = {
				...channels[row.channel_id],
				[item.id]: resolve(row.price_minor, row.channel_id),
			};
		}
	}
	return { base, channels };
}
