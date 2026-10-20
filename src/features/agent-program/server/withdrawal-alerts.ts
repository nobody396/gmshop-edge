import { z } from "zod";
import {
	beijingClock,
	claimPeriod,
} from "#/features/ops-automation/server/shared";
import {
	type OwnerActionContext,
	proposeOwnerAction,
} from "#/features/telegram/server/owner-actions";
import { DomainError } from "#/lib/domain-error";
import { withdrawalsSchema } from "../schema";
import { requestProgram } from "./client";

/**
 * Once a day (from 10:00 Beijing) every pending lsrai.shop withdrawal that has
 * no open request gets a Telegram message: the owner pays in Alipay, taps
 * "已打款" and replies with the Alipay trade number, which marks it paid.
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
			 FROM owner_action_requests WHERE kind = 'agent_withdrawal_paid'
			  AND status IN ('pending', 'processing') AND expires_at > ?`,
		)
		.bind(now)
		.all<{ withdrawal_id: number }>();
	const known = new Set(open.results.map((row) => Number(row.withdrawal_id)));
	let proposed = 0;
	for (const withdrawal of withdrawals) {
		if (withdrawal.status !== "pending" || known.has(withdrawal.id)) continue;
		await proposeOwnerAction(input.db, {
			kind: "agent_withdrawal_paid",
			payload: { withdrawalId: withdrawal.id, amount: withdrawal.amount },
			text: [
				`💸 代理提现待打款 #${withdrawal.id}`,
				`代理：${withdrawal.label}（${withdrawal.email}）`,
				`金额：¥${withdrawal.amount}`,
				`支付宝账号：${withdrawal.account}`,
				`申请时间：${withdrawal.created_at}`,
				"在支付宝转账后点「已打款」，再回复支付宝订单号。",
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
