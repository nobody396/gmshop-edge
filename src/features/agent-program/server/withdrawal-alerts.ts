import { z } from "zod";
import {
	beijingClock,
	claimInterval,
	claimPeriod,
} from "#/features/ops-automation/server/shared";
import {
	type OwnerActionContext,
	proposeOwnerAction,
} from "#/features/telegram/server/owner-actions";
import {
	callTelegram,
	resolveTelegramOwnerAlertCredentials,
	sendOwnerAlert,
} from "#/features/telegram/server/owner-alerts";
import { DomainError } from "#/lib/domain-error";
import { withdrawalsSchema } from "../schema";
import { requestProgram } from "./client";

/**
 * Every Monday (from 10:00 Beijing) one Telegram message lists every pending
 * lsrai.shop withdrawal with lsrai.shop's pre-payout checks and the total
 * (owner 2026-11-02: weekly, not one message per request). The owner pays in
 * Alipay and taps "已全部打款": the Mac runner looks each transfer up and,
 * when exactly one transfer matches, the withdrawal is marked paid with it;
 * results are appended to the same message. Any doubt falls back to asking
 * the owner for that withdrawal's Alipay trade number.
 */

const alertHour = 10;
const settlementWeekday = 1; // Monday
const batchTtlMs = 6 * 86_400_000; // gone before next Monday's summary
const lastDayKey = "ops.withdrawal_alerts.last_day";
// A failed pull must not burn the day: retry every 10 minutes and tell the
// owner once per day that the push is failing (2026-10-21..26 it failed
// silently for five days).
const lastAttemptKey = "ops.withdrawal_alerts.last_attempt";
const failureDayKey = "ops.withdrawal_alerts.failure_day";
const retryMs = 10 * 60_000;

async function settingIs(db: D1Database, key: string, value: string) {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key = ?")
		.bind(key)
		.first<{ value: string }>();
	return row?.value === JSON.stringify(value);
}

function beijingTime(now: number) {
	return new Date(now + 8 * 3_600_000).toISOString().slice(11, 16);
}

export async function runWithdrawalAlerts(input: {
	db: D1Database;
	token: string | undefined;
	now?: number;
	fetcher?: typeof fetch;
}) {
	const now = input.now ?? Date.now();
	if (!input.token?.trim()) return { status: "unconfigured" as const };
	const clock = beijingClock(now);
	if (clock.weekday !== settlementWeekday)
		return { status: "not_settlement_day" as const };
	if (clock.hour < alertHour) return { status: "waiting" as const };
	if (await settingIs(input.db, lastDayKey, clock.day))
		return { status: "done" as const };
	if (!(await claimInterval(input.db, lastAttemptKey, now, retryMs)))
		return { status: "retry_wait" as const };
	let withdrawals: z.infer<typeof withdrawalsSchema>;
	try {
		withdrawals = await requestProgram(
			input.token,
			"withdrawals?status=pending",
			withdrawalsSchema,
			"GET",
			undefined,
			input.fetcher,
		);
	} catch {
		if (await claimPeriod(input.db, failureDayKey, clock.day, now))
			await sendOwnerAlert(
				input.db,
				`⚠️ 代理提现推送失败：拉不到 lsrai.shop 的待打款提现（北京时间 ${beijingTime(now)}）。系统每 10 分钟自动重试，恢复后会照常推送。`,
				{ fetcher: input.fetcher, topic: "withdrawals" },
			).catch(() => null);
		return { status: "failed" as const };
	}
	if (!(await claimPeriod(input.db, lastDayKey, clock.day, now)))
		return { status: "done" as const };
	if (await settingIs(input.db, failureDayKey, clock.day))
		await sendOwnerAlert(
			input.db,
			`✅ 代理提现推送已恢复（北京时间 ${beijingTime(now)}），今天待打款 ${withdrawals.length} 笔。`,
			{ fetcher: input.fetcher, topic: "withdrawals" },
		).catch(() => null);
	const open = await input.db
		.prepare(
			`SELECT json_extract(payload, '$.withdrawalId') AS withdrawal_id
			 FROM owner_action_requests
			 WHERE kind IN ('agent_withdrawal_paid', 'agent_withdrawal_paid_manual')
			  AND status IN ('pending', 'processing') AND expires_at > ?
			 UNION ALL
			 SELECT json_extract(order_json, '$.target.id') FROM supplier_topup_jobs
			 WHERE step = ? AND status IN ('queued', 'running')`,
		)
		.bind(now, withdrawalVerifyStep)
		.all<{ withdrawal_id: number }>();
	const known = new Set(open.results.map((row) => Number(row.withdrawal_id)));
	const batches = await input.db
		.prepare(
			`SELECT payload FROM owner_action_requests
			 WHERE kind = 'agent_withdrawal_batch_paid'
			  AND status IN ('pending', 'processing') AND expires_at > ?`,
		)
		.bind(now)
		.all<{ payload: string }>();
	for (const row of batches.results)
		for (const id of batchPayloadSchema.parse(JSON.parse(row.payload))
			.withdrawalIds)
			known.add(id);
	const fresh = withdrawals.filter(
		(w) => w.status === "pending" && !known.has(w.id),
	);
	if (!fresh.length)
		return { status: "ran" as const, pending: withdrawals.length, proposed: 0 };
	// One account's withdrawals stay in the same message (one transfer may pay
	// them together); at most ~batchSize per message keeps it under Telegram's
	// 4,096-character limit.
	const byAccount = new Map<string, Withdrawal[]>();
	for (const w of fresh) {
		const key = w.account.trim();
		byAccount.set(key, [...(byAccount.get(key) ?? []), w]);
	}
	const chunks: Withdrawal[][] = [];
	let current: Withdrawal[] = [];
	for (const group of byAccount.values()) {
		if (current.length && current.length + group.length > batchSize) {
			chunks.push(current);
			current = [];
		}
		current.push(...group);
	}
	if (current.length) chunks.push(current);
	const grandTotal = fresh.reduce((sum, w) => sum + cents(w.amount), 0);
	try {
		for (const [index, chunk] of chunks.entries())
			await proposeBatch(input.db, chunk, {
				part: chunks.length > 1 ? `第 ${index + 1}/${chunks.length} 条，` : "",
				grand:
					chunks.length > 1
						? `；本周共 ${fresh.length} 笔 ¥${yuan(grandTotal)}`
						: "",
				now,
				fetcher: input.fetcher,
			});
	} catch {
		// Not burned: the 10-minute retry resends what was not posted (posted
		// summaries are open batches and are skipped).
		await input.db
			.prepare("DELETE FROM system_settings WHERE key = ?")
			.bind(lastDayKey)
			.run();
		return { status: "failed" as const };
	}
	return {
		status: "ran" as const,
		pending: withdrawals.length,
		proposed: fresh.length,
	};
}

const batchSize = 20;
const cents = (amount: string) => Math.round(Number(amount) * 100);
const yuan = (minor: number) => (minor / 100).toFixed(2);

async function proposeBatch(
	db: D1Database,
	chunk: Withdrawal[],
	options: { part: string; grand: string; now: number; fetcher?: typeof fetch },
) {
	const total = chunk.reduce((sum, w) => sum + cents(w.amount), 0);
	const flagged = chunk.filter((w) => w.checks.length).length;
	const lines = [
		`💸 本周代理提现待打款：${options.part}${chunk.length} 笔，合计 ¥${yuan(total)}${options.grand}`,
		`（北京时间 ${beijingStamp(options.now)} 已核对：收款账号是否为代理登记账号、代理状态、冻结余额${flagged ? `；⚠️ ${flagged} 笔有问题，先别打` : ""}）`,
	];
	chunk.forEach((w, index) => {
		lines.push(
			"",
			`${index + 1}. ${w.label}（${w.email}）`,
			`支付宝：${w.account}`,
			`金额：¥${w.amount}`,
			w.checks.length ? `⚠️ ${w.checks.join("；")}` : "✅ 核对通过",
		);
	});
	lines.push(
		"",
		"转完后点「已全部打款」：系统去支付宝逐笔找转账、回填订单号并标记已打款；对不上的会单独问你。",
	);
	await proposeOwnerAction(db, {
		kind: "agent_withdrawal_batch_paid",
		payload: {
			withdrawalIds: chunk.map((w) => w.id),
			requestKey: crypto.randomUUID(),
		},
		text: lines.join("\n"),
		choices: ["✅ 已全部打款"],
		rejectLabel: "⏸ 先不处理",
		fallback: "转账后请到后台「代理」逐笔标记已打款。",
		ttlMs: batchTtlMs,
		now: options.now,
		fetcher: options.fetcher,
	});
}

const batchPayloadSchema = z.object({
	withdrawalIds: z.array(z.number().int().positive()).min(1).max(200),
	requestKey: z.string().uuid(),
});

const payloadSchema = z.object({
	withdrawalId: z.number().int().positive(),
	amount: z.string(),
	requestKey: z.string().uuid().optional(),
	reason: z.string().optional(),
});

export async function markWithdrawalPaidFromTelegram(
	context: OwnerActionContext & { fetcher?: typeof fetch },
	rawPayload: unknown,
	_choice: number,
	tradeNo?: string,
) {
	const payload = payloadSchema.parse(rawPayload);
	if (!tradeNo)
		throw new DomainError(
			"withdrawal_trade_no_missing",
			400,
			"缺少支付宝订单号",
		);
	try {
		await requestProgram(
			context.agentProgramToken,
			`withdrawals/${payload.withdrawalId}/mark-paid`,
			z.object({ id: z.number(), status: z.string() }),
			"POST",
			{
				alipay_trade_no: tradeNo,
				operator: `telegram:${context.decidedBy ?? "owner"}`,
			},
			context.fetcher,
		);
	} catch {
		throw new DomainError(
			"withdrawal_mark_paid_failed",
			502,
			"代理站没有确认（可能已用别的订单号标记过）",
		);
	}
	return `✅ 已标记打款：¥${payload.amount}，支付宝订单号 ${tradeNo}`;
}

// ---------------- automatic Alipay check ----------------

/** supplier_topup_jobs step for "find this payout in Alipay" (Mac runner). */
export const withdrawalVerifyStep = "withdrawal_verify";

type Withdrawal = z.infer<typeof withdrawalsSchema>[number];

const verifyItem = (w: Withdrawal) => ({
	id: w.id,
	amount: w.amount,
	account: w.account,
	created_at: w.created_at,
});

/**
 * "已打款" tapped: queue one Alipay lookup for the Mac runner. The job carries
 * the other pending withdrawals to the same account (one transfer may pay
 * them together) and every trade number already used, so a transfer is never
 * matched twice.
 */
export async function queueWithdrawalVerify(
	context: OwnerActionContext & { fetcher?: typeof fetch },
	rawPayload: unknown,
) {
	const payload = payloadSchema.parse(rawPayload);
	const all = await requestProgram(
		context.agentProgramToken,
		"withdrawals",
		withdrawalsSchema,
		"GET",
		undefined,
		context.fetcher,
	);
	const target = all.find((w) => w.id === payload.withdrawalId);
	if (!target || target.status !== "pending")
		throw new DomainError(
			"withdrawal_not_pending",
			409,
			"这笔提现已经不是待打款",
		);
	await insertVerifyJob(
		context,
		all,
		target,
		`withdrawal:${target.id}:${payload.requestKey ?? "legacy"}`,
	);
	return "⏳ 正在自动核对支付宝转账（约 20 秒）";
}

/** "已全部打款" on the Monday summary: one Alipay lookup per withdrawal. */
export async function queueWithdrawalBatchVerify(
	context: OwnerActionContext & { fetcher?: typeof fetch },
	rawPayload: unknown,
) {
	const payload = batchPayloadSchema.parse(rawPayload);
	const all = await requestProgram(
		context.agentProgramToken,
		"withdrawals",
		withdrawalsSchema,
		"GET",
		undefined,
		context.fetcher,
	);
	const pending = payload.withdrawalIds
		.map((id) => all.find((w) => w.id === id && w.status === "pending"))
		.filter((w): w is Withdrawal => Boolean(w));
	if (!pending.length)
		throw new DomainError(
			"withdrawal_not_pending",
			409,
			"这些提现都已经不是待打款",
		);
	// One lookup per account: a transfer can then never settle two withdrawals
	// from separate jobs (2026-11-02 review). The runner tries the first
	// withdrawal alone, then the account's withdrawals together.
	const byAccount = new Map<string, Withdrawal[]>();
	for (const w of pending) {
		const key = w.account.trim();
		byAccount.set(key, [...(byAccount.get(key) ?? []), w]);
	}
	for (const group of byAccount.values()) {
		const target = group[0] as Withdrawal;
		await insertVerifyJob(
			context,
			all,
			target,
			`withdrawal:${target.id}:${payload.requestKey}`,
			payload.requestKey,
			group,
		);
	}
	const skipped = payload.withdrawalIds.length - pending.length;
	return `⏳ 正在去支付宝核对 ${pending.length} 笔转账（约 1 分钟），结果逐行写在下面${skipped ? `；另有 ${skipped} 笔已处理过，跳过` : ""}`;
}

async function insertVerifyJob(
	context: OwnerActionContext,
	all: Withdrawal[],
	target: Withdrawal,
	actionKey: string,
	batchKey?: string,
	only?: Withdrawal[],
) {
	const group =
		only ??
		all.filter(
			(w) =>
				w.status === "pending" && w.account.trim() === target.account.trim(),
		);
	const used = [
		...new Set(all.map((w) => w.alipay_trade_no.trim()).filter(Boolean)),
	];
	const id = crypto.randomUUID();
	await context.db
		.prepare(
			`INSERT INTO supplier_topup_jobs
			 (id, topup_id, step, supplier_id, supplier_name, amount_cny, status,
			  action_key, order_json, created_at, updated_at)
			 VALUES (?, ?, ?, 'alipay', '代理提现', 0, 'queued', ?, ?, ?, ?)`,
		)
		.bind(
			id,
			id,
			withdrawalVerifyStep,
			actionKey,
			JSON.stringify({
				target: { ...verifyItem(target), label: target.label },
				group: group.map(verifyItem),
				used_trade_nos: used,
				...(batchKey ? { batch_key: batchKey } : {}),
			}),
			context.now,
			context.now,
		)
		.run();
}

type VerifyJob = { id: string; order_json: string | null };
type Fetcher = typeof fetch;

const verifyOrderSchema = z.object({
	target: z.object({
		id: z.number().int().positive(),
		amount: z.string(),
		account: z.string(),
		label: z.string().optional(),
	}),
	group: z.array(
		z.object({ id: z.number().int().positive(), amount: z.string() }),
	),
	batch_key: z.string().uuid().optional(),
});

/** The runner's lookup result: mark paid on one exact match, else ask the owner. */
export async function recordWithdrawalVerifyResult(
	db: D1Database,
	job: VerifyJob,
	body:
		| {
				outcome: "withdrawal_matched";
				trade_no: string;
				amount: string;
				trans_dt: string;
				withdrawal_ids: number[];
		  }
		| {
				outcome: "withdrawal_unmatched" | "failed" | "uncertain";
				reason: string;
		  },
	options: { now: number; fetcher?: Fetcher; agentProgramToken?: string },
) {
	const order = verifyOrderSchema.parse(JSON.parse(job.order_json ?? "{}"));
	const allowed = new Set([order.target.id, ...order.group.map((w) => w.id)]);
	const finish = (status: string, result: unknown) =>
		db
			.prepare(
				`UPDATE supplier_topup_jobs SET status = ?, result = ?, updated_at = ?
				 WHERE id = ? AND status = 'running'`,
			)
			.bind(status, JSON.stringify(result), options.now, job.id)
			.run();
	const amounts = new Map(
		[order.target, ...order.group].map((w) => [w.id, w.amount]),
	);
	let reason = "";
	const paid: number[] = [];
	if (body.outcome === "withdrawal_matched") {
		const ids = [...new Set(body.withdrawal_ids)];
		if (
			!ids.length ||
			ids.some((id) => !allowed.has(id)) ||
			!ids.includes(order.target.id)
		)
			reason = "核对结果对应的提现单不在这次范围内";
		else if (
			Math.round(Number(body.amount) * 100) !==
			ids
				.map((id) => Math.round(Number(amounts.get(id) ?? Number.NaN) * 100))
				.reduce((a, b) => a + b, 0)
		)
			reason = "支付宝转账金额和这几笔提现的合计对不上";
		else {
			for (const id of ids) {
				try {
					await requestProgram(
						options.agentProgramToken,
						`withdrawals/${id}/mark-paid`,
						z.object({ id: z.number(), status: z.string() }),
						"POST",
						{
							alipay_trade_no: body.trade_no,
							operator: "telegram:auto-alipay",
						},
						options.fetcher,
					);
					paid.push(id);
				} catch {
					reason = `代理站没有确认 #${id} 的打款标记`;
				}
			}
		}
	} else reason = body.reason;

	const stamp = beijingStamp(options.now);
	if (paid.length && body.outcome === "withdrawal_matched") {
		const total = paid
			.map((id) => Number(amounts.get(id) ?? 0))
			.reduce((a, b) => a + b, 0)
			.toFixed(2);
		const merged =
			paid.length > 1 ? `（提现 #${paid.join("、#")} 合并一笔）` : "";
		await editAlertMessages(
			db,
			paid,
			`✅ 已自动核对支付宝转账并标记打款：¥${total}${merged}，订单号 ${body.trade_no}（转账时间 ${body.trans_dt}，北京时间 ${stamp}）`,
			options,
		);
	}
	if (order.batch_key) {
		// Batch jobs cover a whole account: every withdrawal of it that was not
		// paid by this transfer gets its own trade-number prompt.
		const who = order.target.label ? `${order.target.label} ` : "";
		const left = [order.target, ...order.group]
			.map((w) => w.id)
			.filter((id, index, ids) => ids.indexOf(id) === index)
			.filter((id) => !paid.includes(id));
		const leftReason =
			reason ||
			(paid.length ? "同一账号还有别的提现，这笔需要你回复订单号" : "没找到");
		const lines: string[] = [];
		if (paid.length && body.outcome === "withdrawal_matched")
			lines.push(
				`✅ #${paid.join("、#")} ${who}¥${yuan(paid.map((id) => cents(amounts.get(id) ?? "0")).reduce((a, b) => a + b, 0))} 已标记打款，订单号 ${body.trade_no}`,
			);
		for (const id of left)
			lines.push(
				`⚠️ #${id} ${who}¥${amounts.get(id)} 没对上：${leftReason}（已单独发消息，回复订单号即可）`,
			);
		await finish(left.length ? "unmatched" : "done", {
			...body,
			paid,
			line: lines.join("\n"),
		});
		await refreshBatchMessage(db, order.batch_key, options);
		for (const id of left)
			await proposeManual(
				db,
				{
					...order.target,
					id,
					amount: amounts.get(id) ?? order.target.amount,
				},
				leftReason,
				options,
			);
		return { status: "recorded" as const, paid };
	}
	await finish(paid.length && !reason ? "done" : "unmatched", {
		...body,
		paid,
	});
	if (reason && !paid.includes(order.target.id))
		await proposeManual(db, order.target, reason, options);
	return { status: "recorded" as const, paid };
}

/** Old flow: ask the owner to reply with the trade number. */
async function proposeManual(
	db: D1Database,
	target: z.infer<typeof verifyOrderSchema>["target"],
	reason: string,
	options: { now: number; fetcher?: Fetcher },
) {
	await proposeOwnerAction(db, {
		kind: "agent_withdrawal_paid_manual",
		payload: { withdrawalId: target.id, amount: target.amount, reason },
		text: [
			`⚠️ 提现 #${target.id}（¥${target.amount}，支付宝 ${target.account}）没有自动核对上：${reason}`,
			"确认已转账的话点「已打款」，再回复支付宝订单号。",
		].join("\n"),
		choices: ["✅ 已打款（填订单号）"],
		rejectLabel: "⏸ 先不处理",
		fallback: "转账后请到后台「代理」标记已打款。",
		now: options.now,
		fetcher: options.fetcher,
	});
}

/**
 * Rebuilds the Monday summary from its finished jobs, so results arriving in
 * any order (or while the tap is still being recorded) are never lost.
 */
async function refreshBatchMessage(
	db: D1Database,
	batchKey: string,
	options: { now: number; fetcher?: Fetcher },
) {
	const row = await db
		.prepare(
			`SELECT chat_id, message_id, message_text, result FROM owner_action_requests
			 WHERE kind = 'agent_withdrawal_batch_paid'
			  AND json_extract(payload, '$.requestKey') = ? AND message_id IS NOT NULL`,
		)
		.bind(batchKey)
		.first<{
			chat_id: string;
			message_id: number;
			message_text: string;
			result: string | null;
		}>();
	const jobs = await db
		.prepare(
			`SELECT json_extract(result, '$.line') AS line FROM supplier_topup_jobs
			 WHERE step = ? AND json_extract(order_json, '$.batch_key') = ?
			  AND status IN ('done', 'unmatched') ORDER BY updated_at, id`,
		)
		.bind(withdrawalVerifyStep, batchKey)
		.all<{ line: string | null }>();
	const credentials = await resolveTelegramOwnerAlertCredentials(db);
	if (!row || !credentials) return;
	const tapped = row.result ?? "⏳ 正在去支付宝核对转账";
	const lines = jobs.results.map((j) => j.line).filter(Boolean);
	await callTelegram(
		credentials,
		"editMessageText",
		{
			chat_id: row.chat_id,
			message_id: row.message_id,
			text: [row.message_text, "", tapped, ...lines].join("\n").slice(0, 4096),
			link_preview_options: { is_disabled: true },
			reply_markup: { inline_keyboard: [] },
		},
		options.fetcher ?? fetch,
		"telegram_alert_delivery_failed",
	).catch(() => undefined);
}

/** Adds the result line to each withdrawal's original alert. */
async function editAlertMessages(
	db: D1Database,
	ids: number[],
	line: string,
	options: { now: number; fetcher?: Fetcher },
) {
	const credentials = await resolveTelegramOwnerAlertCredentials(db);
	for (const id of ids) {
		const row = await db
			.prepare(
				`SELECT id, chat_id, message_id, message_text, status
				 FROM owner_action_requests WHERE kind = 'agent_withdrawal_paid'
				  AND json_extract(payload, '$.withdrawalId') = ?
				  AND message_id IS NOT NULL
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.bind(id)
			.first<{
				id: string;
				chat_id: string;
				message_id: number;
				message_text: string;
				status: string;
			}>();
		if (!row) continue;
		// A sibling alert still waiting for its own tap is settled by this transfer.
		if (row.status === "pending")
			await db
				.prepare(
					`UPDATE owner_action_requests SET status = 'approved', result = ?,
					 updated_at = ? WHERE id = ? AND status = 'pending'`,
				)
				.bind(line, options.now, row.id)
				.run();
		if (!credentials) continue;
		await callTelegram(
			credentials,
			"editMessageText",
			{
				chat_id: row.chat_id,
				message_id: row.message_id,
				text: `${row.message_text}\n\n${line}`,
				link_preview_options: { is_disabled: true },
				reply_markup: { inline_keyboard: [] },
			},
			options.fetcher ?? fetch,
			"telegram_alert_delivery_failed",
		).catch(() => undefined);
	}
}

function beijingStamp(now: number) {
	return new Date(now + 8 * 3_600_000)
		.toISOString()
		.slice(5, 16)
		.replace("T", " ");
}
