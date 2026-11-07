import { DomainError } from "#/lib/domain-error";
import { encryptSecret } from "#/lib/secrets";
import { gptUpgradeProduct } from "../products";
import { assertOpenUpgradeQuote, loadUpgradeQuote } from "./client";

export async function prepareUpgradeCheckout(
	db: D1Database,
	input: {
		items: Array<{
			sellableItemId: string;
			quantity: number;
			renewedFromEntitlementId?: string | null;
		}>;
		couponCode?: string;
		upgradeQuoteToken?: string;
	},
	secret: string,
) {
	if (
		!input.items.some(
			(item) => item.sellableItemId === gptUpgradeProduct.itemId,
		)
	)
		return null;
	const item = input.items[0];
	if (
		input.items.length !== 1 ||
		item?.quantity !== 1 ||
		item.renewedFromEntitlementId ||
		input.couponCode ||
		!input.upgradeQuoteToken
	)
		throw new DomainError(
			"upgrade_checkout_invalid",
			400,
			"Buy one upgrade separately with a quote and without a coupon",
		);
	const quote = await loadUpgradeQuote(db, secret, input.upgradeQuoteToken);
	assertOpenUpgradeQuote(quote);
	return {
		quote,
		quoteTokenEncrypted: await encryptSecret(
			input.upgradeQuoteToken,
			secret,
			"gpt-upgrade-quote",
		),
	};
}

export function upgradeCheckoutStatements(
	db: D1Database,
	prepared: NonNullable<Awaited<ReturnType<typeof prepareUpgradeCheckout>>>,
	orderItemId: string,
	now: number,
) {
	// Release only closed, unpaid attempts; paid/refunded attempts keep the quote reserved forever.
	return [
		db
			.prepare(
				`UPDATE gpt_upgrade_orders SET active_key=NULL,state='cancelled',updated_at=? WHERE state='pending' AND order_item_id IN (SELECT oi.id FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE o.status IN ('expired','cancelled') AND o.paid_minor='0')`,
			)
			.bind(now),
		db
			.prepare(
				`INSERT INTO gpt_upgrade_orders(order_item_id,quote_id,active_key,quote_token_encrypted,price_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
			)
			.bind(
				orderItemId,
				prepared.quote.quote_id,
				prepared.quote.quote_id,
				prepared.quoteTokenEncrypted,
				prepared.quote.price_minor,
				now,
				now,
			),
	];
}
