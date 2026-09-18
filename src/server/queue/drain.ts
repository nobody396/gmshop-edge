import { publishPendingBuilds } from "#/features/builds/server/outbox";
import { publishPendingDeliveries } from "#/features/fulfillment/server/outbox";
import { flushPendingCommerceNotifications } from "#/features/notifications/server/flush";
import { publishPendingOwnerSaleAlerts } from "#/features/notifications/server/owner-sale-alerts";
import { publishPendingRefunds } from "#/features/shop-payments/server/refunds";
import { publishPendingInventoryEvents } from "#/features/supplier-api/server/inventory-events";
import { publishPendingSupplierOrders } from "#/features/suppliers/server/outbox";

/**
 * Publishes every pending commerce outbox event to the queue. Runs after each
 * queue batch and each non-GET web request, because any of them can commit new
 * pending events (a supplier purchase finalization writes delivery.requested,
 * an auth write writes notification.requested, and so on). The minute cron
 * remains the durable recovery path; this drain is what keeps paid orders and
 * auth emails from waiting for it.
 */
export async function drainPendingCommerceOutbox(db: D1Database, queue: Queue) {
	await publishPendingDeliveries(db, queue);
	await publishPendingSupplierOrders(db, queue);
	await publishPendingBuilds(db, queue);
	await publishPendingRefunds(db, queue);
	await flushPendingCommerceNotifications(db, queue);
	await publishPendingOwnerSaleAlerts({ db });
	await publishPendingInventoryEvents(db, queue);
}
