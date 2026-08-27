import { dispatchBuild } from "#/features/builds/providers/github-actions";
import { processDelivery } from "#/features/fulfillment/server/process";
import { processNotificationDelivery } from "#/features/notifications/server/delivery";
import { flushPendingCommerceNotifications } from "#/features/notifications/server/flush";
import { processShopRefund } from "#/features/shop-payments/server/refunds";
import { processSupplierOrder } from "#/features/suppliers/server/process";
import type { CommerceQueueMessage } from "#/server/queue/types";

export async function handleQueue(
	batch: MessageBatch<CommerceQueueMessage>,
	env: Env,
) {
	const results: Array<"completed" | "rejected" | "retried"> = [];
	for (let index = 0; index < batch.messages.length; index += 3) {
		const chunk = batch.messages.slice(index, index + 3);
		results.push(
			...(await Promise.all(
				chunk.map((message) => processMessage(batch.queue, message, env)),
			)),
		);
	}
	await flushPendingCommerceNotifications(env.DB, env.COMMERCE_QUEUE, 100);
	const oldest = batch.messages.reduce(
		(ageMs, message) =>
			Math.max(ageMs, Date.now() - message.timestamp.getTime()),
		0,
	);
	console.info(
		JSON.stringify({
			event: "commerce_queue_completed",
			queue: batch.queue,
			batchSize: batch.messages.length,
			completed: results.filter((result) => result === "completed").length,
			rejected: results.filter((result) => result === "rejected").length,
			retried: results.filter((result) => result === "retried").length,
			oldestMessageAgeMs: oldest,
		}),
	);
}

async function processMessage(
	queue: string,
	message: Message<CommerceQueueMessage>,
	env: Env,
): Promise<"completed" | "rejected" | "retried"> {
	const db = env.DB;
	if (!isCommerceQueueMessage(message.body)) {
		await db
			.prepare(
				`INSERT INTO audit_logs
				 (id, action, target_type, target_id, after, created_at)
				 VALUES (?, 'queue.message_rejected', 'queue_message', ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				queue,
				JSON.stringify({
					code: "invalid_queue_message",
					attempts: message.attempts,
				}),
				Date.now(),
			)
			.run();
		message.ack();
		return "rejected";
	}
	try {
		await processQueueMessage(message.body, env);
		message.ack();
		return "completed";
	} catch {
		message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
		return "retried";
	}
}

async function processQueueMessage(body: CommerceQueueMessage, env: Env) {
	const db = env.DB;
	switch (body.kind) {
		case "commerce.delivery":
			return processDelivery(db, body.deliveryId);
		case "commerce.automation":
			return dispatchBuild(db, body.automationJobId);
		case "commerce.notification":
			return processNotificationDelivery(db, body.notificationDeliveryId, {
				cloudflareEmail: env.EMAIL,
			});
		case "commerce.refund":
			return processShopRefund(db, body.refundId);
		case "commerce.supplier":
			return processSupplierOrder(db, body.supplierOrderId);
	}
}

export function retryDelaySeconds(attempts: number) {
	return Math.min(300, 15 * 2 ** Math.max(0, attempts - 1));
}

export function queueMessageKind(value: unknown) {
	return isCommerceQueueMessage(value) ? "commerce" : "invalid";
}

function isCommerceQueueMessage(value: unknown): value is CommerceQueueMessage {
	if (!isRecord(value) || value.version !== 1) return false;
	switch (value.kind) {
		case "commerce.delivery":
			return validReference(value, "deliveryId");
		case "commerce.automation":
			return validReference(value, "automationJobId");
		case "commerce.notification":
			return validReference(value, "notificationDeliveryId");
		case "commerce.refund":
			return validReference(value, "refundId");
		case "commerce.supplier":
			return validReference(value, "supplierOrderId");
		default:
			return false;
	}
}

function validReference(value: Record<string, unknown>, key: string) {
	const reference = value[key];
	return (
		Object.keys(value).length === 3 &&
		typeof reference === "string" &&
		reference.length > 0 &&
		reference.length <= 128
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
