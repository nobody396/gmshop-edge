import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	enqueueEmailNotification,
	processEmailNotification,
} from "#/features/notifications/server/delivery";
import {
	type CloudflareEmailEvent,
	deliveryEvidenceStatements,
	planDeliveryEvidence,
} from "#/features/notifications/server/delivery-evidence";
import { applyMigrations } from "./migrations";

describe("final email delivery evidence", { timeout: 30_000 }, () => {
	let runtime: Miniflare;
	let db: D1Database;
	const at = Date.parse("2026-09-21T13:29:12Z");
	const baseRow = {
		id: "notice",
		status: "accepted",
		provider_message_id: "<mail-1@shop.com>",
		accepted_at: at,
		created_at: at - 60_000,
		provider_event_at: null,
		from_address: "Shop <mail@shop.com>",
	};
	const event: CloudflareEmailEvent = {
		datetime: "2026-09-23T21:29:58Z",
		from: "Shop <mail@shop.com>",
		to: "buyer@customer.com",
		messageId: baseRow.provider_message_id,
		status: "deliveryFailed",
		errorCause: "transport_none",
		errorDetail: "Failed to connect to egress transport: no usable transport",
		isLastEvent: 1,
	};
	beforeEach(async () => {
		runtime = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await runtime.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO notification_deliveries (id,event,channel,idempotency_key,message_encrypted,message_key_version,status,attempt_count,provider_message_id,accepted_at,created_at,updated_at) VALUES ('notice','auth.email_verification','email','verify-1','encrypted',1,'accepted',1,?,?,?,?)",
			)
			.bind(baseRow.provider_message_id, at, at, at)
			.run();
	});
	afterEach(async () => runtime.dispose());
	it("reconciles a terminal bounce without making it retryable or sending again", async () => {
		const plan = await planDeliveryEvidence(baseRow, event.to, [event]);
		expect(plan).toMatchObject({ status: "bounced", suppress: false });
		if (!plan) throw new Error("Missing plan");
		await db.batch(
			deliveryEvidenceStatements(plan).map((s) =>
				db.prepare(s.sql).bind(...s.params),
			),
		);
		const row = await db
			.prepare(
				"SELECT status,delivered_at,next_attempt_at,error_code,provider_event_at FROM notification_deliveries WHERE id='notice'",
			)
			.first();
		expect(row).toMatchObject({
			status: "bounced",
			delivered_at: null,
			next_attempt_at: null,
			error_code: "provider_transport_none",
		});
		const send = vi.fn();
		expect(
			await processEmailNotification(db, "notice", {
				cloudflareEmail: { send } as unknown as SendEmail,
			}),
		).toEqual({ duplicate: true, status: "bounced" });
		expect(send).not.toHaveBeenCalled();
		expect(
			await planDeliveryEvidence(
				{ ...baseRow, status: "bounced", provider_event_at: plan.occurredAt },
				event.to,
				[event],
			),
		).toBeNull();
	});
	it("suppresses an explicit nonexistent mailbox before a subsequent notification is queued", async () => {
		const plan = await planDeliveryEvidence(baseRow, event.to, [
			{ ...event, errorCause: "mailbox_gmail_unknown" },
		]);
		if (!plan) throw new Error("Missing plan");
		await db.batch(
			deliveryEvidenceStatements(plan).map((s) =>
				db.prepare(s.sql).bind(...s.params),
			),
		);
		await db
			.prepare(
				"INSERT INTO system_settings (key,value,is_secret) VALUES ('runtime.data_encryption_secret','\"local-test-secret\"',1)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO notification_channel_configs (id,channel,name,provider,from_address,enabled) VALUES ('email','email','test','cloudflare_email','mail@shop.com',1)",
			)
			.run();
		const next = await enqueueEmailNotification(db, {
			event: "auth.email_verification",
			idempotencyKey: "verify-2",
			message: {
				to: event.to,
				from: "mail@shop.com",
				replyTo: "",
				subject: "Verify",
				text: "private",
				html: "",
			},
		});
		expect(next.status).toBe("suppressed");
		expect(
			await db.prepare("SELECT count(*) AS n FROM outbox_events").first("n"),
		).toBe(0);
		const stored = await db
			.prepare("SELECT * FROM email_recipient_suppressions")
			.all();
		expect(JSON.stringify(stored.results)).not.toContain(event.to);
	});
	it("writes the recipient-server time only with positive delivery evidence", async () => {
		const plan = await planDeliveryEvidence(baseRow, event.to, [
			{ ...event, status: "delivered", errorCause: "", errorDetail: "" },
		]);
		if (!plan) throw new Error("Missing plan");
		await db.batch(
			deliveryEvidenceStatements(plan).map((s) =>
				db.prepare(s.sql).bind(...s.params),
			),
		);
		expect(
			await db
				.prepare(
					"SELECT status,delivered_at,accepted_at FROM notification_deliveries WHERE id='notice'",
				)
				.first(),
		).toEqual({
			status: "delivered",
			delivered_at: Date.parse(event.datetime),
			accepted_at: at,
		});
	});
	it("does not write from retry events, wrong identities, stale or conflicting evidence", async () => {
		for (const candidate of [
			{ ...event, isLastEvent: 0 },
			{ ...event, messageId: "other" },
			{ ...event, to: "someone@customer.com" },
			{ ...event, from: "other@shop.com" },
			{ ...event, datetime: "2026-09-19T00:00:00Z" },
		])
			expect(
				await planDeliveryEvidence(baseRow, event.to, [candidate]),
			).toBeNull();
		await expect(
			planDeliveryEvidence(baseRow, event.to, [
				event,
				{ ...event, status: "delivered" },
			]),
		).rejects.toThrow("Conflicting");
		await expect(
			planDeliveryEvidence({ ...baseRow, status: "delivered" }, event.to, [
				event,
			]),
		).rejects.toThrow("Conflicting");
	});
	it("does not overwrite a concurrent terminal state", async () => {
		const plan = await planDeliveryEvidence(baseRow, event.to, [event]);
		if (!plan) throw new Error("Missing plan");
		await db
			.prepare(
				"UPDATE notification_deliveries SET status='delivered', provider_event_at=? WHERE id='notice'",
			)
			.bind(Date.parse(event.datetime))
			.run();
		await db.batch(
			deliveryEvidenceStatements(plan).map((s) =>
				db.prepare(s.sql).bind(...s.params),
			),
		);
		expect(
			await db
				.prepare("SELECT status FROM notification_deliveries WHERE id='notice'")
				.first("status"),
		).toBe("delivered");
	});
	it("reclassifies legacy submission timestamps without resending or downgrading verified receipts", async () => {
		await db
			.prepare(
				"UPDATE notification_deliveries SET status='delivered',accepted_at=NULL,delivered_at=? WHERE id='notice'",
			)
			.bind(at)
			.run();
		const migration = await readFile(
			new URL(
				"../../drizzle/0016_email_delivery_evidence.sql",
				import.meta.url,
			),
			"utf8",
		);
		const upgrade = migration.split("--> statement-breakpoint").at(-1);
		if (!upgrade) throw new Error("Missing upgrade");
		await db.prepare(upgrade).run();
		expect(
			await db
				.prepare(
					"SELECT status,accepted_at,delivered_at FROM notification_deliveries WHERE id='notice'",
				)
				.first(),
		).toEqual({ status: "accepted", accepted_at: at, delivered_at: null });
		expect(
			await db.prepare("SELECT count(*) AS n FROM outbox_events").first("n"),
		).toBe(0);
		await db
			.prepare(
				"UPDATE notification_deliveries SET status='delivered',provider_event_at=?,delivered_at=? WHERE id='notice'",
			)
			.bind(at + 5000, at + 5000)
			.run();
		await db.prepare(upgrade).run();
		expect(
			await db
				.prepare("SELECT status FROM notification_deliveries WHERE id='notice'")
				.first("status"),
		).toBe("delivered");
	});
	it("uses the provider-message index for reconciliation", async () => {
		const result = await db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT id FROM notification_deliveries WHERE provider_message_id=?",
			)
			.bind(baseRow.provider_message_id)
			.all();
		expect(JSON.stringify(result.results)).toContain(
			"notification_deliveries_provider_message_idx",
		);
	});
});
