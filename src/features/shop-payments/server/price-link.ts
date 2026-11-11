import { DomainError } from "#/lib/domain-error";

/**
 * Channel price links. A channel whose price_source_channel_id points at
 * another channel always charges that channel's channel prices: database
 * triggers (migration 0054) copy every insert/update/delete of the source's
 * prices and refuse a linked price that differs from its source. Used so the
 * Alipay order-QR channel charges exactly what the existing 支付宝 channel does.
 */

export async function assertPriceSource(
	db: D1Database,
	channelId: string,
	sourceId: string | null,
) {
	if (!sourceId) return;
	const source = await db
		.prepare(
			`SELECT id, price_source_channel_id,
			 EXISTS (SELECT 1 FROM payment_channels follower
			  WHERE follower.price_source_channel_id = ?) AS followed
			 FROM payment_channels WHERE id = ? LIMIT 1`,
		)
		.bind(channelId, sourceId)
		.first<{
			id: string;
			price_source_channel_id: string | null;
			followed: number;
		}>();
	// No self links and no chains: a source never follows another channel and a
	// followed channel never follows one itself.
	if (
		!source ||
		sourceId === channelId ||
		source.price_source_channel_id !== null ||
		Number(source.followed) === 1
	)
		throw new DomainError(
			"payment_price_source_invalid",
			400,
			"Choose a channel that has its own prices",
		);
}

/**
 * Statements around a channel save that (re)link its prices. `before` runs
 * before the channel row is written, `after` after it.
 */
export function priceLinkStatements(
	db: D1Database,
	input: {
		channelId: string;
		sourceId: string | null;
		now: number;
	},
) {
	if (!input.sourceId) return { before: [], after: [] };
	return {
		before: [
			// Unlinked while the copy is replaced, so the guards do not apply.
			db
				.prepare(
					"UPDATE payment_channels SET price_source_channel_id = NULL WHERE id = ?",
				)
				.bind(input.channelId),
			db
				.prepare(
					"DELETE FROM sellable_item_channel_prices WHERE channel_id = ?",
				)
				.bind(input.channelId),
		],
		after: [
			db
				.prepare(
					`INSERT INTO sellable_item_channel_prices
					 (id, sellable_item_id, channel_id, price_minor, enabled, created_at, updated_at)
					 SELECT source.id || ':' || ?, source.sellable_item_id, ?, source.price_minor,
					  source.enabled, ?, ?
					 FROM sellable_item_channel_prices source WHERE source.channel_id = ?`,
				)
				.bind(
					input.channelId,
					input.channelId,
					input.now,
					input.now,
					input.sourceId,
				),
		],
	};
}
