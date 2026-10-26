import { z } from "zod";
import {
	beijingClock,
	claimPeriod,
} from "#/features/ops-automation/server/shared";
import {
	type OwnerActionContext,
	proposeOwnerAction,
} from "#/features/telegram/server/owner-actions";
import {
	callTelegram,
	resolveTelegramOwnerAlertCredentials,
} from "#/features/telegram/server/owner-alerts";
import { DomainError } from "#/lib/domain-error";
import { withdrawalsSchema } from "../schema";
import { requestProgram } from "./client";

/**
 * Once a day (from 10:00 Beijing) every pending lsrai.shop withdrawal that has
 * no open request gets a Telegram message. The owner pays in Alipay and taps
 * "已打款": the Mac runner looks the transfer up with alipay-source and, when
 * exactly one transfer matches, the withdrawal is marked paid with it. Any
 * doubt falls back to asking the owner for the Alipay trade number.
 */

const alertHour = 10;
const lastDayKey = "ops.withdrawal_alerts.last_day";

export async function runWithdrawalAlerts(input: {
	db: D1Database;
	token: string | undefined;
	now?: number;
	fetcher?: typeof fetch;
}) {
	const now = input.now ?? Date.now();
	if (!input.token?.trim()) return { status: "unconfigured" as const };
	const clock = beijingClock(now);
	if (clock.hour < alertHour) return { status: "waiting" as const };
	if (!(await claimPeriod(input.db, lastDayKey, clock.day, now)))
		return { status: "done" as const };
	const withdrawals = await requestProgram(
		input.token,
		"withdrawals?status=pending",
		withdrawalsSchema,
		"GET",
		undefined,
		input.fetcher,
	);
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
	let proposed = 0;
	for (const withdrawal of withdrawals) {
		if (withdrawal.status !== "pending" || known.has(withdrawal.id)) continue;
		await proposeOwnerAction(input.db, {
			kind: "agent_withdrawal_paid",
			payload: {
				withdrawalId: withdrawal.id,
				amount: withdrawal.amount,
				requestKey: crypto.randomUUID(),
			},
			text: [
				`💸 代理提现待打款 #${withdrawal.id}`,
				`代理：${withdrawal.label}（${withdrawal.email}）`,
				`金额：¥${withdrawal.amount}`,
				`支付宝账号：${withdrawal.account}`,
				`申请时间：${withdrawal.created_at}`,
				"在支付宝转账后点「已打款」，系统会自动核对支付宝转账并标记。",
			].join("\n"),
			choices: ["✅ 已打款"],
			rejectLabel: "⏸ 先不处理",
			fallback: "转账后请到后台「代理」标记已打款。",
			now,
			fetcher: input.fetcher,
		});
		proposed += 1;
	}
	return { status: "ran" as const, pending: withdrawals.length, proposed };
}

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
	const group = all.filter(
		(w) => w.status === "pending" && w.account.trim() === target.account.trim(),
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
			`withdrawal:${target.id}:${payload.requestKey ?? "legacy"}`,
			JSON.stringify({
				target: { ...verifyItem(target), label: target.label },
				group: group.map(verifyItem),
				used_trade_nos: used,
			}),
			context.now,
			context.now,
		)
		.run();
	return "⏳ 正在自动核对支付宝转账（约 20 秒）";
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
