import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fanOutPendingCommerceNotifications } from "#/features/notifications/server/fanout";
import {
	exceptionTodoSettingKey,
	runRedemptionExceptionTodos,
} from "#/features/redeem-warehouse/server/exception-todos";
import producerFeed from "../fixtures/redeem-exceptions.json";
import { applyMigrations } from "./migrations";

const clock = 2_000_000;
const id = "00000000-0000-4000-8000-000000000001";
const snapshot = {
	id,
	reference: "00000000-0000-4000-8000-000000000002",
	sku: "GPT_PLUS_PH",
	product_name: "ChatGPT Plus 菲律宾",
	storefront: "lsrai",
	state: "open",
	severity: 1,
	reason_code: "account.subscription_incompatible",
	reason: "账号订阅不符合本商品要求",
	resolution: null,
	diagnosis: {
		stage: "充值提交",
		submission: "rejected",
		card_usage: "unknown",
		next_step: "请核对原订单，不要重复充值",
	},
};
const feed = (cases: unknown[], now = clock, extra = {}) => ({
	observed_at: now,
	next_cursor: null,
	cases,
	missing_ids: [],
	...extra,
});

describe("proactive redemption exception todos", { timeout: 30_000 }, () => {
	let mf: Miniflare, db: D1Database;
	beforeEach(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
	});
	afterEach(async () => mf.dispose());
	async function enable(enabled = true) {
		await db
			.prepare(
				"INSERT INTO system_settings (key,value,is_secret,created_at,updated_at) VALUES (?,?,0,0,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
			)
			.bind(exceptionTodoSettingKey, JSON.stringify({ enabled, since: 0 }))
			.run();
	}
	const deliver = () =>
		vi
			.fn<(text: string, uuid: string) => Promise<void>>()
			.mockResolvedValue(undefined);
	const run = (cases: unknown[], now = clock, send = deliver()) =>
		runRedemptionExceptionTodos({
			db,
			now,
			readFeed: async () => feed(cases, now),
			deliver: send,
		});
	const todo = () =>
		db
			.prepare("SELECT * FROM redeem_exception_todos WHERE code_id=?")
			.bind(id)
			.first<{ state: string; revision: number; alert_attempted: number }>();

	it("is opt-in, with no reads or sends while disabled", async () => {
		const readFeed = vi.fn(),
			send = deliver();
		expect(
			await runRedemptionExceptionTodos({
				db,
				now: clock,
				readFeed,
				deliver: send,
			}),
		).toMatchObject({ status: "disabled" });
		expect(readFeed).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
	it("persists one todo and stays silent on unchanged snapshots or a new reference", async () => {
		await enable();
		const send = deliver();
		expect(await run([snapshot], clock, send)).toMatchObject({
			changed: 1,
			accepted: 1,
		});
		expect(
			await run(
				[{ ...snapshot, reference: crypto.randomUUID() }],
				clock + 60_000,
				send,
			),
		).toMatchObject({ changed: 0, accepted: 0 });
		expect(send).toHaveBeenCalledTimes(1);
		expect(await todo()).toMatchObject({ state: "open", revision: 1 });
		expect(send.mock.calls[0]?.[0]).toContain(snapshot.reference);
		expect(send.mock.calls[0]?.[0]).toContain("提交被明确拒绝");
		expect(send.mock.calls[0]?.[1]).toMatch(/^[\da-f-]{36}$/);
		expect(
			(
				await db
					.prepare(
						"SELECT count(*) AS n FROM outbox_events WHERE event_type='redeem.exception_todo'",
					)
					.first<{ n: number }>()
			)?.n,
		).toBe(1);
	});
	it("notifies worsening and explicit resolution, once per revision", async () => {
		await enable();
		const send = deliver();
		await run([snapshot], clock, send);
		await run([{ ...snapshot, severity: 2 }], clock + 60_000, send);
		await run(
			[{ ...snapshot, state: "resolved", resolution: "voided" }],
			clock + 120_000,
			send,
		);
		await run(
			[{ ...snapshot, state: "resolved", resolution: "voided" }],
			clock + 180_000,
			send,
		);
		expect(send).toHaveBeenCalledTimes(3);
		expect(send.mock.calls[2]?.[0]).toContain("不代表已退款");
		expect(await todo()).toMatchObject({ state: "resolved", revision: 3 });
	});
	it("does not treat a partial page or missing source record as resolution", async () => {
		await enable();
		const send = deliver();
		await run([snapshot], clock, send);
		const readFeed = vi.fn(async (body: { tracked_ids: string[] }) => {
			expect(body.tracked_ids).toContain(id);
			return feed([], clock + 60_000, { missing_ids: [id] });
		});
		expect(
			await runRedemptionExceptionTodos({
				db,
				now: clock + 60_000,
				readFeed,
				deliver: send,
			}),
		).toMatchObject({ status: "partial", accepted: 0 });
		expect(await todo()).toMatchObject({ state: "open", revision: 1 });
		expect(send).toHaveBeenCalledTimes(1);
		expect(await run([], clock + 120_000, send)).toMatchObject({
			status: "source_unavailable",
		});
		expect(await todo()).toMatchObject({ state: "open" });
	});
	it("does not close a previously raised case just because it is being checked again", async () => {
		await enable();
		const send = deliver();
		await run([snapshot], clock, send);
		await run([{ ...snapshot, state: "waiting" }], clock + 60_000, send);
		expect(await todo()).toMatchObject({ state: "open", revision: 1 });
		expect(send).toHaveBeenCalledTimes(1);
	});
	it("rejects private fields, credentials, stale snapshots and malformed results before recording or sending", async () => {
		await enable();
		const send = deliver();
		for (const bad of [
			feed([{ ...snapshot, raw_key: "SECRET" }]),
			feed([{ ...snapshot, reason: "TEST-AAAA-BBBB-CCCC-DDDD" }]),
			feed([{ ...snapshot, reason: "private@example.com" }]),
			feed([snapshot], clock - 180_000),
			feed([snapshot, snapshot]),
			feed([{ ...snapshot, state: "resolved", resolution: null }]),
		])
			expect(
				await runRedemptionExceptionTodos({
					db,
					now: clock,
					readFeed: async () => bad,
					deliver: send,
				}),
			).toMatchObject({ status: "source_unavailable" });
		expect(await todo()).toBeNull();
		expect(send).not.toHaveBeenCalled();
	});
	it("retries with the same provider UUID, then stops after three failures", async () => {
		await enable();
		const send = vi
			.fn<(text: string, uuid: string) => Promise<void>>()
			.mockRejectedValue(new Error("network unknown"));
		for (const offset of [0, 60_000, 120_000, 180_000])
			await run([snapshot], clock + offset, send);
		expect(send).toHaveBeenCalledTimes(3);
		expect(new Set(send.mock.calls.map((c) => c[1])).size).toBe(1);
		expect(
			await db
				.prepare(
					"SELECT status,attempt_count FROM outbox_events WHERE event_type='redeem.exception_todo'",
				)
				.first(),
		).toMatchObject({ status: "failed", attempt_count: 3 });
	});
	it("claims polling and delivery across concurrent cron invocations", async () => {
		await enable();
		const send = deliver();
		await Promise.all([
			run([snapshot], clock, send),
			run([snapshot], clock, send),
			run([snapshot], clock, send),
		]);
		expect(send).toHaveBeenCalledTimes(1);
		expect(await todo()).toMatchObject({ revision: 1 });
	});
	it("honors disablement during the source request", async () => {
		await enable();
		const send = deliver();
		expect(
			await runRedemptionExceptionTodos({
				db,
				now: clock,
				readFeed: async () => {
					await enable(false);
					return feed([snapshot]);
				},
				deliver: send,
			}),
		).toMatchObject({ status: "disabled" });
		expect(await todo()).toBeNull();
		expect(send).not.toHaveBeenCalled();
	});
	it("keeps a resolution queued while an earlier send is in flight, without reopening the todo", async () => {
		await enable();
		let release!: () => void, entered!: () => void;
		const started = new Promise<void>((r) => {
			entered = r;
		});
		const barrier = new Promise<void>((r) => {
			release = r;
		});
		const send = vi.fn(async () => {
			entered();
			await barrier;
		});
		const first = run([snapshot], clock, send);
		await started;
		expect(
			await run(
				[{ ...snapshot, state: "resolved", resolution: "completed" }],
				clock + 30_000,
				deliver(),
			),
		).toMatchObject({ accepted: 0, changed: 1 });
		expect(await todo()).toMatchObject({ state: "resolved", revision: 2 });
		release();
		await first;
		const resolvedSender = deliver();
		const reads = vi.fn(async (body: { tracked_ids: string[] }) => {
			expect(body.tracked_ids).toContain(id);
			return feed(
				[{ ...snapshot, state: "resolved", resolution: "completed" }],
				clock + 60_000,
			);
		});
		expect(
			await runRedemptionExceptionTodos({
				db,
				now: clock + 60_000,
				readFeed: reads,
				deliver: resolvedSender,
			}),
		).toMatchObject({ accepted: 1 });
		expect(resolvedSender.mock.calls[0]?.[0]).toContain("已确认充值完成");
		expect(await todo()).toMatchObject({ state: "resolved" });
	});
	it("advances and wraps the discovery cursor while tracking open cases separately", async () => {
		await enable();
		const send = deliver();
		await runRedemptionExceptionTodos({
			db,
			now: clock,
			readFeed: async () => feed([snapshot], clock, { next_cursor: id }),
			deliver: send,
		});
		const next = vi.fn(
			async (body: { cursor: string | null; tracked_ids: string[] }) => {
				expect(body.cursor).toBe(id);
				expect(body.tracked_ids).toContain(id);
				return feed([snapshot], clock + 60_000);
			},
		);
		await runRedemptionExceptionTodos({
			db,
			now: clock + 60_000,
			readFeed: next,
			deliver: send,
		});
		const wrapped = vi.fn(async (body: { cursor: string | null }) => {
			expect(body.cursor).toBeNull();
			return feed([snapshot], clock + 120_000);
		});
		await runRedemptionExceptionTodos({
			db,
			now: clock + 120_000,
			readFeed: wrapped,
			deliver: send,
		});
		expect(send).toHaveBeenCalledTimes(1);
	});
	it("does not route owner exception events into customer email", async () => {
		await enable();
		await run([snapshot]);
		await fanOutPendingCommerceNotifications(db);
		expect(
			(
				await db
					.prepare("SELECT COUNT(*) AS n FROM notification_deliveries")
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
	});
	it("commits state and notification atomically", async () => {
		await enable();
		await db
			.prepare(
				"CREATE TRIGGER reject_exception_event BEFORE INSERT ON outbox_events WHEN NEW.event_type='redeem.exception_todo' BEGIN SELECT RAISE(ABORT,'fixture outbox failure'); END",
			)
			.run();
		expect(await run([snapshot])).toMatchObject({
			status: "source_unavailable",
		});
		expect(await todo()).toBeNull();
	});
	it("keeps the tracked-case and due-event queries indexed", async () => {
		const plan = await db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT code_id FROM redeem_exception_todos WHERE state='open' ORDER BY last_checked_at,code_id LIMIT 50",
			)
			.all();
		expect(JSON.stringify(plan.results)).toContain(
			"redeem_exception_todos_open_idx",
		);
	});
	it("does not send a resolution when the open alert never started", async () => {
		await enable();
		await db
			.prepare(
				"CREATE TRIGGER pause_exception_claim BEFORE UPDATE OF attempt_count ON outbox_events WHEN NEW.event_type='redeem.exception_todo' BEGIN SELECT RAISE(IGNORE); END",
			)
			.run();
		const send = deliver();
		await run([snapshot], clock, send);
		expect(send).not.toHaveBeenCalled();
		await db.prepare("DROP TRIGGER pause_exception_claim").run();
		await run(
			[{ ...snapshot, state: "resolved", resolution: "completed" }],
			clock + 60_000,
			send,
		);
		expect(send).not.toHaveBeenCalled();
		expect(await todo()).toMatchObject({ state: "resolved" });
	});
	it("does not replay an ambiguous crashed send after its retry budget", async () => {
		await enable();
		const send = deliver();
		await run([snapshot], clock, send);
		send.mockClear();
		await db
			.prepare(
				"UPDATE outbox_events SET status='pending',attempt_count=3,next_attempt_at=? WHERE event_type='redeem.exception_todo'",
			)
			.bind(clock)
			.run();
		await run([snapshot], clock + 60_000, send);
		expect(send).not.toHaveBeenCalled();
		expect(
			await db
				.prepare(
					"SELECT status FROM outbox_events WHERE event_type='redeem.exception_todo'",
				)
				.first(),
		).toMatchObject({ status: "failed" });
	});
	// Captured from the redeem service's real local-D1 HTTP integration, synthetic IDs only.
	it("accepts the actual producer wire contract without an adapter or private data", async () => {
		await enable();
		const send = deliver();
		const result = await runRedemptionExceptionTodos({
			db,
			now: producerFeed.observed_at,
			readFeed: async () => producerFeed,
			deliver: send,
		});
		const openCount = producerFeed.cases.filter(
			(row) => row.state === "open",
		).length;
		expect(openCount).toBeGreaterThan(0);
		expect(result).toMatchObject({
			status: "ok",
			changed: openCount,
			accepted: openCount,
		});
		expect(JSON.stringify(send.mock.calls)).not.toMatch(
			/fixture-session|fixture-cookie|PRIVATE|key_ciphertext|upstream_order_id/,
		);
	});
});
