import { z } from "zod";
import {
	type OwnerActionContext,
	proposeOwnerAction,
} from "#/features/telegram/server/owner-actions";
import {
	callTelegram,
	ownerAlertThreadId,
	resolveTelegramOwnerAlertCredentials,
	sendOwnerAlert,
} from "#/features/telegram/server/owner-alerts";
import { DomainError } from "#/lib/domain-error";

/**
 * Upstream wallet top-ups from the low-balance alert (2026-10-26).
 *
 * The gateway hands its low-balance alert to `offerSupplierTopUp`, which posts
 * it with amount buttons. A tap queues a `create` job; the Mac runner claims
 * it, places the order and reports the QR, which is posted with a
 * "充值完成" button. That tap queues a `collect` job: the runner verifies
 * payment, redeems and records the expense, then reports the live balance.
 *
 * Money rules: a tap queues at most one job (`action_key`), a supplier has at
 * most one open top-up, claimed jobs are never re-queued, and an uncertain
 * outcome is reported instead of retried.
 */

export const supplierTopUpAmounts = [50, 100, 200] as const;
export const supportedTopUpSuppliers = ["pomoai", "xingwan", "icodeeasy"];
/** An unpaid order is treated as abandoned after this long. */
const openTopUpMs = 24 * 3_600_000;
const maxQrBytes = 500_000;

type Fetcher = typeof fetch;

type JobRow = {
	id: string;
	topup_id: string;
	step: "create" | "collect";
	supplier_id: string;
	supplier_name: string;
	amount_cny: number;
	status: string;
	order_json: string | null;
};

const jobColumns = `id, topup_id, step, supplier_id, supplier_name,
	amount_cny, status, order_json`;

async function openTopUp(db: D1Database, supplierId: string, now: number) {
	return db
		.prepare(
			`SELECT ${jobColumns} FROM supplier_topup_jobs
			 WHERE supplier_id = ? AND step = 'create'
			  AND status IN ('queued', 'running', 'awaiting_payment')
			  AND created_at > ?
			 ORDER BY created_at DESC LIMIT 1`,
		)
		.bind(supplierId, now - openTopUpMs)
		.first<JobRow>();
}

function describeOpen(row: JobRow) {
	return row.status === "awaiting_payment"
		? `已有一笔 ¥${row.amount_cny} 的付款码在等付款：付完点那条消息的「充值完成」`
		: `已有一笔 ¥${row.amount_cny} 的充值正在下单`;
}

const offerSchema = z.object({
	supplier_id: z.string().min(1).max(64),
	supplier_name: z.string().min(1).max(64),
	text: z.string().min(1).max(3_000),
});

/** The gateway's low-balance alert, re-posted with top-up buttons. */
export async function offerSupplierTopUp(
	db: D1Database,
	rawBody: unknown,
	options: { now?: number; fetcher?: Fetcher } = {},
) {
	const now = options.now ?? Date.now();
	const body = offerSchema.parse(rawBody);
	if (!supportedTopUpSuppliers.includes(body.supplier_id))
		throw new DomainError(
			"supplier_topup_unsupported",
			422,
			"Supplier not supported",
		);
	const open = await openTopUp(db, body.supplier_id, now);
	if (open) {
		const sent = await sendOwnerAlert(
			db,
			`${body.text}\n\n⏳ ${describeOpen(open)}。`,
			{ fetcher: options.fetcher, topic: "restock" },
		);
		if (!sent)
			throw new DomainError("supplier_topup_unavailable", 503, "No channel");
		return { status: "open_topup" as const };
	}
	await supersedeOffers(db, body.supplier_id, now, options.fetcher);
	const proposal = await proposeOwnerAction(db, {
		kind: "supplier_topup_offer",
		payload: {
			offerId: crypto.randomUUID(),
			supplierId: body.supplier_id,
			supplierName: body.supplier_name,
		},
		text: body.text,
		choices: supplierTopUpAmounts.map((amount) => `💳 充 ¥${amount}`),
		rejectLabel: "🙅 不充值",
		// Without working buttons the gateway sends its own plain alert.
		fallback: null,
		now,
		fetcher: options.fetcher,
	});
	if (!proposal)
		throw new DomainError("supplier_topup_unavailable", 503, "No buttons");
	return { status: "offered" as const };
}

/** Only the newest alert per supplier keeps its amount buttons. */
async function supersedeOffers(
	db: D1Database,
	supplierId: string,
	now: number,
	fetcher?: Fetcher,
) {
	const rows = await db
		.prepare(
			`UPDATE owner_action_requests SET status = 'expired', updated_at = ?
			 WHERE kind = 'supplier_topup_offer' AND status = 'pending'
			  AND json_extract(payload, '$.supplierId') = ?
			 RETURNING chat_id, message_id, message_text`,
		)
		.bind(now, supplierId)
		.all<{ chat_id: string; message_id: number; message_text: string }>();
	const credentials = await resolveTelegramOwnerAlertCredentials(db);
	if (!credentials) return;
	for (const row of rows.results)
		await callTelegram(
			credentials,
			"editMessageText",
			{
				chat_id: row.chat_id,
				message_id: row.message_id,
				text: `${row.message_text}\n\n（已有更新的余额提醒，按钮移到新消息）`,
				reply_markup: { inline_keyboard: [] },
			},
			fetcher ?? fetch,
			"telegram_alert_delivery_failed",
		).catch(() => undefined);
}

const offerPayloadSchema = z.object({
	offerId: z.string().uuid(),
	supplierId: z.string(),
	supplierName: z.string(),
});

/** Owner picked an amount: queue exactly one `create` job. */
export async function approveSupplierTopUpOffer(
	context: OwnerActionContext,
	rawPayload: unknown,
	choice: number,
) {
	const payload = offerPayloadSchema.parse(rawPayload);
	const amount = supplierTopUpAmounts[choice];
	if (!amount)
		throw new DomainError("supplier_topup_bad_choice", 400, "金额选项无效");
	const open = await openTopUp(context.db, payload.supplierId, context.now);
	if (open)
		throw new DomainError("supplier_topup_open", 409, describeOpen(open));
	const id = crypto.randomUUID();
	await context.db
		.prepare(
			`INSERT INTO supplier_topup_jobs
			 (id, topup_id, step, supplier_id, supplier_name, amount_cny, status,
			  action_key, created_at, updated_at)
			 VALUES (?, ?, 'create', ?, ?, ?, 'queued', ?, ?, ?)`,
		)
		.bind(
			id,
			id,
			payload.supplierId,
			payload.supplierName,
			amount,
			`offer:${payload.offerId}`,
			context.now,
			context.now,
		)
		.run();
	return `⏳ 充 ¥${amount}：Mac 正在下单，付款码马上发到这里`;
}

const paidPayloadSchema = z.object({
	promptId: z.string().uuid(),
	topupId: z.string().uuid(),
});

/** Owner says they paid: queue one `collect` job for that order. */
export async function approveSupplierTopUpPaid(
	context: OwnerActionContext,
	rawPayload: unknown,
) {
	const payload = paidPayloadSchema.parse(rawPayload);
	const topUp = await context.db
		.prepare(`SELECT ${jobColumns} FROM supplier_topup_jobs WHERE id = ?`)
		.bind(payload.topupId)
		.first<JobRow>();
	if (!topUp || topUp.status !== "awaiting_payment")
		throw new DomainError("supplier_topup_closed", 409, "这笔充值已经结束");
	const busy = await context.db
		.prepare(
			`SELECT 1 FROM supplier_topup_jobs WHERE topup_id = ? AND step = 'collect'
			  AND status IN ('queued', 'running', 'uncertain', 'done') LIMIT 1`,
		)
		.bind(topUp.id)
		.first();
	if (busy)
		throw new DomainError(
			"supplier_topup_busy",
			409,
			"这笔充值已经在核验或已入账",
		);
	await context.db
		.prepare(
			`INSERT INTO supplier_topup_jobs
			 (id, topup_id, step, supplier_id, supplier_name, amount_cny, status,
			  action_key, order_json, created_at, updated_at)
			 VALUES (?, ?, 'collect', ?, ?, ?, 'queued', ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			topUp.id,
			topUp.supplier_id,
			topUp.supplier_name,
			topUp.amount_cny,
			`paid:${payload.promptId}`,
			topUp.order_json,
			context.now,
			context.now,
		)
		.run();
	return "⏳ 正在核验付款、入账并查最新余额";
}

/** "不充值了" on the QR: the unpaid order is abandoned. */
export async function rejectSupplierTopUpPaid(
	context: OwnerActionContext,
	rawPayload: unknown,
) {
	const payload = paidPayloadSchema.parse(rawPayload);
	await context.db
		.prepare(
			`UPDATE supplier_topup_jobs SET status = 'abandoned', updated_at = ?
			 WHERE id = ? AND status = 'awaiting_payment'`,
		)
		.bind(context.now, payload.topupId)
		.run();
}

/** Hands the oldest queued job to the Mac runner; claimed jobs never re-queue. */
export async function claimSupplierTopUpJob(db: D1Database, now: number) {
	const job = await db
		.prepare(
			`UPDATE supplier_topup_jobs SET status = 'running', claimed_at = ?,
			 updated_at = ?
			 WHERE id = (SELECT id FROM supplier_topup_jobs WHERE status = 'queued'
			  ORDER BY created_at LIMIT 1) AND status = 'queued'
			 RETURNING ${jobColumns}`,
		)
		.bind(now, now)
		.first<JobRow>();
	if (!job) return null;
	return {
		id: job.id,
		topup_id: job.topup_id,
		step: job.step,
		supplier_id: job.supplier_id,
		supplier_name: job.supplier_name,
		amount_cny: job.amount_cny,
		order: job.order_json ? JSON.parse(job.order_json) : null,
	};
}

const orderSchema = z.object({
	reference: z.string().min(1).max(128),
	amount_cny: z.string().max(32),
	qr_png_base64: z.string().max(Math.ceil((maxQrBytes * 4) / 3) + 4),
});

const resultSchema = z.discriminatedUnion("outcome", [
	z.object({
		job_id: z.string().uuid(),
		outcome: z.literal("order_created"),
		channel: z.enum(["支付宝", "微信"]),
		total_cny: z.string().max(32),
		orders: z.array(orderSchema).min(1).max(5),
	}),
	z.object({
		job_id: z.string().uuid(),
		outcome: z.literal("collected"),
		balance_cny: z.string().max(32),
		balance_checked_at: z.string().max(64),
		ledger_ids: z.array(z.union([z.string(), z.number()])).max(5),
	}),
	z.object({ job_id: z.string().uuid(), outcome: z.literal("unpaid") }),
	z.object({
		job_id: z.string().uuid(),
		// failed: nothing happened upstream; uncertain: it may have.
		outcome: z.enum(["failed", "uncertain"]),
		reason: z.string().max(500),
	}),
]);

/** The runner's report for one claimed job; each job accepts one report. */
export async function recordSupplierTopUpResult(
	db: D1Database,
	rawBody: unknown,
	options: { now?: number; fetcher?: Fetcher } = {},
) {
	const now = options.now ?? Date.now();
	const body = resultSchema.parse(rawBody);
	const job = await db
		.prepare(`SELECT ${jobColumns} FROM supplier_topup_jobs WHERE id = ?`)
		.bind(body.job_id)
		.first<JobRow>();
	if (!job) throw new DomainError("supplier_topup_job_missing", 404, "No job");
	if (job.status !== "running")
		return { status: "duplicate" as const, jobStatus: job.status };
	const name = job.supplier_name;
	const say = (text: string) =>
		sendOwnerAlert(db, text, { fetcher: options.fetcher, topic: "restock" });
	const finish = (status: string, result: unknown, orderJson?: string) =>
		db
			.prepare(
				`UPDATE supplier_topup_jobs SET status = ?, result = ?,
				 order_json = COALESCE(?, order_json), updated_at = ?
				 WHERE id = ? AND status = 'running'`,
			)
			.bind(status, JSON.stringify(result), orderJson ?? null, now, job.id)
			.run();
	const setTopUp = (status: string) =>
		db
			.prepare(
				`UPDATE supplier_topup_jobs SET status = ?, updated_at = ?
				 WHERE id = ? AND step = 'create'`,
			)
			.bind(status, now, job.topup_id)
			.run();
	const stamp = `北京时间 ${beijingStamp(now)}`;

	if (job.step === "create") {
		if (body.outcome === "order_created") {
			const orders = body.orders.map(({ reference, amount_cny }) => ({
				reference,
				amount_cny,
			}));
			const orderJson = JSON.stringify({
				channel: body.channel,
				total_cny: body.total_cny,
				orders,
			});
			// QR and button go out before the job closes: a failed send leaves the
			// job running, so the runner re-reports the same order, never a new one.
			for (const [index, order] of body.orders.entries())
				await sendQrPhoto(
					db,
					order.qr_png_base64,
					[
						`💳 ${name} 充值 ¥${body.total_cny}${body.orders.length > 1 ? `（第 ${index + 1}/${body.orders.length} 张，¥${order.amount_cny}）` : ""}`,
						`请用「${body.channel}」扫码付款`,
						`订单号：${order.reference}`,
					].join("\n"),
					options.fetcher,
				);
			await finish("awaiting_payment", { channel: body.channel }, orderJson);
			await proposePaid(
				db,
				{ ...job, status: "awaiting_payment" },
				body.channel,
				body.total_cny,
				now,
				false,
				options.fetcher,
			);
			return { status: "recorded" as const };
		}
		if (body.outcome === "failed" || body.outcome === "uncertain") {
			await finish(body.outcome, { reason: body.reason });
			await say(
				body.outcome === "failed"
					? `⚠️ ${name} 充 ¥${job.amount_cny} 没有下单成功：${body.reason}\n没有生成订单，下次余额提醒可以重新选金额。（${stamp}）`
					: `⚠️ ${name} 充 ¥${job.amount_cny} 下单结果不确定：${body.reason}\n可能已经生成了订单，系统不会自动重试，请找 Claude 核对。（${stamp}）`,
			);
			return { status: "recorded" as const };
		}
	} else {
		if (body.outcome === "collected") {
			await finish("done", body);
			await setTopUp("paid");
			await say(
				[
					`✅ ${name} 充值 ¥${job.amount_cny} 已到账并记账${body.ledger_ids.length ? `（账 #${body.ledger_ids.join("、#")}）` : ""}`,
					`最新余额：¥${body.balance_cny}（实查 ${body.balance_checked_at}）`,
				].join("\n"),
			);
			return { status: "recorded" as const };
		}
		if (body.outcome === "unpaid") {
			await finish("unpaid", body);
			const order = job.order_json
				? (JSON.parse(job.order_json) as {
						channel?: string;
						total_cny?: string;
					})
				: {};
			await proposePaid(
				db,
				job,
				order.channel ?? "支付宝",
				order.total_cny ?? String(job.amount_cny),
				now,
				true,
				options.fetcher,
			);
			return { status: "recorded" as const };
		}
		if (body.outcome === "failed" || body.outcome === "uncertain") {
			await finish(body.outcome, { reason: body.reason });
			if (body.outcome === "uncertain") await setTopUp("uncertain");
			await say(
				body.outcome === "failed"
					? `⚠️ ${name} 充值核验没做成：${body.reason}\n没有入账也没有记账，可以等会儿在上面再点「充值完成」。（${stamp}）`
					: `⚠️ ${name} 充值入账结果不确定：${body.reason}\n可能已经兑换或记账，系统不会自动重试，请找 Claude 核对。（${stamp}）`,
			);
			if (body.outcome === "failed") {
				const order = job.order_json
					? (JSON.parse(job.order_json) as {
							channel?: string;
							total_cny?: string;
						})
					: {};
				await proposePaid(
					db,
					job,
					order.channel ?? "支付宝",
					order.total_cny ?? String(job.amount_cny),
					now,
					false,
					options.fetcher,
				);
			}
			return { status: "recorded" as const };
		}
	}
	throw new DomainError(
		"supplier_topup_bad_outcome",
		400,
		`Outcome ${body.outcome} does not fit a ${job.step} job`,
	);
}

async function proposePaid(
	db: D1Database,
	job: JobRow,
	channel: string,
	total: string,
	now: number,
	notPaidYet: boolean,
	fetcher?: Fetcher,
) {
	await proposeOwnerAction(db, {
		kind: "supplier_topup_paid",
		payload: { promptId: crypto.randomUUID(), topupId: job.topup_id },
		text: notPaidYet
			? `🕐 还没查到 ${job.supplier_name} ¥${total} 的付款。\n用「${channel}」扫上面的码付完，再点「充值完成」。`
			: `${job.supplier_name} 充值 ¥${total}：付款码在上面，请用「${channel}」扫码。\n付完点「充值完成」，我会核验到账、记账并报最新余额。`,
		choices: ["✅ 充值完成"],
		rejectLabel: "❌ 不充值了",
		fallback: "按钮暂不可用：付完款请找 Claude 入账。",
		ttlMs: openTopUpMs,
		now,
		fetcher,
	});
}

async function sendQrPhoto(
	db: D1Database,
	base64: string,
	caption: string,
	fetcher?: Fetcher,
) {
	const credentials = await resolveTelegramOwnerAlertCredentials(db);
	if (!credentials)
		throw new DomainError("supplier_topup_unavailable", 503, "No Telegram");
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	if (bytes.byteLength > maxQrBytes || bytes.byteLength < 8)
		throw new DomainError("supplier_topup_bad_qr", 400, "QR image size");
	const form = new FormData();
	form.set("chat_id", credentials.chatId);
	const threadId = ownerAlertThreadId(credentials, "restock");
	if (threadId) form.set("message_thread_id", String(threadId));
	form.set("caption", caption);
	form.set("photo", new Blob([bytes], { type: "image/png" }), "qr.png");
	// The URL embeds the bot token: it is never logged or put in an error.
	const response = await (fetcher ?? fetch)(
		`https://api.telegram.org/bot${credentials.botToken}/sendPhoto`,
		{ method: "POST", body: form, signal: AbortSignal.timeout(15_000) },
	).catch(() => null);
	const ok = response?.ok
		? z.object({ ok: z.literal(true) }).safeParse(await response.json()).success
		: false;
	if (!ok)
		throw new DomainError(
			"supplier_topup_qr_send_failed",
			502,
			"QR photo was not delivered",
		);
}

function beijingStamp(now: number) {
	return new Date(now + 8 * 3_600_000)
		.toISOString()
		.slice(5, 16)
		.replace("T", " ");
}
