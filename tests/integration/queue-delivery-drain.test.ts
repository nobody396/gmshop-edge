import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleQueue } from "#/server/queue/routing";
import type { CommerceQueueMessage } from "#/server/queue/types";
import { applyMigrations } from "./migrations";

describe("commerce queue delivery drain", { timeout: 30_000 }, () => {
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

	it("publishes pending delivery outbox events without waiting for cron", async () => {
		const now = Date.now();
		await database
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key,
				  payload, status, attempt_count, created_at, updated_at)
				 VALUES (?, 'delivery.requested', 'delivery', ?, ?, ?, 'pending', 0, ?, ?)`,
			)
			.bind(
				"outbox-delivery-1",
				"delivery-1",
				"supplier-delivery-requested:delivery-1",
				JSON.stringify({ deliveryId: "delivery-1", orderItemId: "item-1" }),
				now,
				now,
			)
			.run();

		const sent: CommerceQueueMessage[] = [];
		const queue = {
			sendBatch: vi.fn(
				async (messages: Array<{ body: CommerceQueueMessage }>) => {
					sent.push(...messages.map((message) => message.body));
				},
			),
		} as unknown as Queue<CommerceQueueMessage>;
		const batch = {
			queue: "gmshop-edge-commerce",
			messages: [],
		} as unknown as MessageBatch<CommerceQueueMessage>;

		await handleQueue(batch, {
			DB: database,
			COMMERCE_QUEUE: queue,
		} as unknown as Env);

		expect(sent).toEqual([
			{ kind: "commerce.delivery", version: 1, deliveryId: "delivery-1" },
		]);
		const row = await database
			.prepare("SELECT status FROM outbox_events WHERE id = ?")
			.bind("outbox-delivery-1")
			.first<{ status: string }>();
		expect(row?.status).toBe("published");
	});
});
