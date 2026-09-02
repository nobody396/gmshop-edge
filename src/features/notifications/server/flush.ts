import { publishPendingNotifications } from "./delivery";
import { fanOutPendingCommerceNotifications } from "./fanout";

/**
 * Moves newly-created customer events through both outbox stages immediately.
 * The minute cron remains the durable recovery path when a request or Queue
 * consumer is interrupted between the database commit and this flush.
 */
export async function flushPendingCommerceNotifications(
	db: D1Database,
	queue: Queue,
	limit = 25,
) {
	const fanout = await fanOutPendingCommerceNotifications(db, limit);
	const published = await publishPendingNotifications(db, queue, limit);
	return { fanout, published };
}
