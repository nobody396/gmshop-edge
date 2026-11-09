export type AccountOrderRow = {
	order_number: string;
	status: string;
	currency: string;
	currency_decimals: number;
	total_minor: string;
	product_id: string | null;
	product_name: string | null;
	sellable_item_name: string | null;
	cover_object_key: string | null;
	product_updated_at: number | null;
	item_count: number;
	created_at: number;
	updated_at: number;
};

/** The signed-in customer's latest orders, each summarised by its first item. */
export function listStoreAccountOrders(db: D1Database, userId: string) {
	return db
		.prepare(
			`SELECT o.order_number, o.status, o.currency, o.currency_decimals,
			 o.total_minor, o.created_at, o.updated_at,
			 first.product_id, first.product_name, first.sellable_item_name,
			 product.cover_object_key, product.updated_at AS product_updated_at,
			 (SELECT COUNT(*) FROM shop_order_items WHERE order_id = o.id) AS item_count
			 FROM shop_orders o
			 LEFT JOIN shop_order_items first ON first.id = (
			   SELECT id FROM shop_order_items WHERE order_id = o.id
			   ORDER BY created_at, id LIMIT 1)
			 LEFT JOIN products product ON product.id = first.product_id
			 WHERE o.user_id = ?
			 ORDER BY o.created_at DESC, o.id DESC LIMIT 100`,
		)
		.bind(userId)
		.all<AccountOrderRow>();
}

export function accountOrderSummary(order: AccountOrderRow) {
	return {
		orderNumber: order.order_number,
		status: order.status,
		currency: order.currency,
		currencyDecimals: order.currency_decimals,
		totalMinor: order.total_minor,
		productName: order.product_name,
		sellableItemName: order.sellable_item_name,
		// Same cover URL the order detail page uses; the client asks for the thumbnail.
		coverUrl:
			order.cover_object_key && order.product_id
				? `/api/shop/products/${order.product_id}/cover?v=${order.product_updated_at}`
				: null,
		itemCount: order.item_count,
		createdAt: order.created_at,
		updatedAt: order.updated_at,
	};
}
