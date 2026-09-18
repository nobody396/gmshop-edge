import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainPendingCommerceOutbox } from "#/server/queue/drain";
import type { CommerceQueueMessage } from "#/server/queue/types";
import { applyMigrations } from "./migrations";

describe("drainPendingCommerceOutbox", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await miniflare.dispose();
	});

	it("publishes every pending outbox event kind without waiting for cron", async () => {
		const now = Date.now();
		const seeds = [
			{
				id: "ob-delivery",
				eventType: "delivery.requested",
				aggregateId: "ob-delivery",
				payload: { deliveryId: "delivery-1", orderItemId: "item-1" },
			},
			{
				id: "ob-supplier",
				eventType: "supplier.requested",
				aggregateId: "ob-supplier",
				payload: { supplierOrderId: "supplier-order-1" },
			},
			{
				id: "ob-notification",
				eventType: "notification.requested",
				// publishPendingNotifications reads aggregate_id, not the payload.
				aggregateId: "notification-1",
				payload: {},
			},
		];
		for (const [index, seed] of seeds.entries()) {
			await database
				.prepare(
					`INSERT INTO outbox_events
					 (id, event_type, aggregate_type, aggregate_id, idempotency_key,
					  payload, status, attempt_count, created_at, updated_at)
					 VALUES (?, ?, 'test', ?, ?, ?, 'pending', 0, ?, ?)`,
				)
				.bind(
					seed.id,
					seed.eventType,
					seed.aggregateId,
					`test:${seed.id}`,
					JSON.stringify(seed.payload),
					now + index,
					now + index,
				)
				.run();
		}

		const sent: CommerceQueueMessage[] = [];
		const queue = {
			sendBatch: vi.fn(
				async (messages: Array<{ body: CommerceQueueMessage }>) => {
					sent.push(...messages.map((message) => message.body));
				},
			),
		} as unknown as Queue;

		await drainPendingCommerceOutbox(database, queue);

		expect(sent).toEqual(
			expect.arrayContaining([
				{ kind: "commerce.delivery", version: 1, deliveryId: "delivery-1" },
				{
					kind: "commerce.supplier",
					version: 1,
					supplierOrderId: "supplier-order-1",
				},
				{
					kind: "commerce.notification",
					version: 1,
					notificationDeliveryId: "notification-1",
				},
			]),
		);
		const rows = await database
			.prepare(
				"SELECT id, status FROM outbox_events WHERE id IN ('ob-delivery', 'ob-supplier', 'ob-notification') ORDER BY id",
			)
			.all<{ id: string; status: string }>();
		expect(rows.results).toEqual([
			{ id: "ob-delivery", status: "published" },
			{ id: "ob-notification", status: "published" },
			{ id: "ob-supplier", status: "published" },
		]);
	});

	it("is a no-op when nothing is pending", async () => {
		const queue = {
			sendBatch: vi.fn(),
		} as unknown as Queue;
		await expect(
			drainPendingCommerceOutbox(database, queue),
		).resolves.toBeUndefined();
		expect(queue.sendBatch).not.toHaveBeenCalled();
	});
});
