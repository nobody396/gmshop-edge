export type RenewableEntitlement = {
	id: string;
	sellable_item_id: string;
	price_minor: string;
};

export function loadRenewableEntitlement(
	database: D1Database,
	userId: string,
	entitlementId: string,
) {
	return database
		.prepare(
			`SELECT ce.id, ce.sellable_item_id, sellable_item.price_minor
			 FROM customer_entitlements ce
			 JOIN product_sellable_items sellable_item ON sellable_item.id = ce.sellable_item_id
			 JOIN products product ON product.id = sellable_item.product_id
			 WHERE ce.id = ? AND ce.user_id = ?
			  AND ce.status IN ('active', 'expired', 'exhausted')
			  AND sellable_item.renewal_mode = 'stack'
			  AND sellable_item.enabled = 1
			  AND sellable_item.sale_disabled = 0
			  AND product.status = 'active'
			  AND product.sale_disabled = 0
			 LIMIT 1`,
		)
		.bind(entitlementId, userId)
		.first<RenewableEntitlement>();
}
