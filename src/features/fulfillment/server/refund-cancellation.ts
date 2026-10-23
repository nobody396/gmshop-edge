/**
 * Stops unfinished supplier procurement and delivery once an order is fully
 * refunded. The statements run inside the refund's D1 batch, after the order
 * row was updated, and only touch rows while the order is `refunded`; a
 * partial or failed refund therefore changes nothing. Bulk AISOU procurement
 * already settles refunded orders itself.
 */
export function cancelOpenFulfillmentStatements(
	db: D1Database,
	orderId: string,
	now: number,
) {
	const refunded =
		"EXISTS (SELECT 1 FROM shop_orders WHERE id = ? AND status = 'refunded')";
	return [
		db
			.prepare(
				`UPDATE supplier_orders SET state = 'refunded', next_retry_at = NULL, updated_at = ?
				 WHERE order_id = ?
				  AND state IN ('pending', 'selecting', 'submitting', 'uncertain', 'failed')
				  AND ${refunded}`,
			)
			.bind(now, orderId, orderId),
		db
			.prepare(
				`UPDATE outbox_events SET status = 'published',
				 published_at = COALESCE(published_at, ?), updated_at = ?
				 WHERE event_type = 'supplier.requested'
				  AND aggregate_id IN (SELECT id FROM supplier_orders WHERE order_id = ?)
				  AND status IN ('pending', 'processing') AND ${refunded}`,
			)
			.bind(now, now, orderId, orderId),
		db
			.prepare(
				`UPDATE delivery_records SET status = 'failed', error_code = 'order_refunded',
				 next_attempt_at = NULL, updated_at = ?
				 WHERE order_item_id IN (SELECT id FROM shop_order_items WHERE order_id = ?)
				  AND status IN ('awaiting_supply', 'pending') AND ${refunded}`,
			)
			.bind(now, orderId, orderId),
		db
			.prepare(
				`UPDATE outbox_events SET status = 'published',
				 published_at = COALESCE(published_at, ?), updated_at = ?
				 WHERE event_type = 'delivery.requested' AND aggregate_type = 'delivery'
				  AND aggregate_id IN (
				   SELECT delivery.id FROM delivery_records delivery
				   JOIN shop_order_items item ON item.id = delivery.order_item_id
				   WHERE item.order_id = ? AND delivery.status = 'failed'
				    AND delivery.error_code = 'order_refunded'
				  ) AND status IN ('pending', 'processing') AND ${refunded}`,
			)
			.bind(now, now, orderId, orderId),
	];
}
