import { z } from "zod";
import { beijingClock } from "#/features/ops-automation/server/shared";
import {
	type OwnerActionContext,
	proposeOwnerAction,
} from "#/features/telegram/server/owner-actions";
import { DomainError } from "#/lib/domain-error";
import { requestProgram } from "./client";

/**
 * "/topup 邮箱 金额" in the owner-alert chat → a confirmation with the
 * partner's current balance → "确认充值" credits the lsrai.shop purchasing
 * wallet. The request number travels with the proposal, and lsrai.shop treats
 * it as the wallet reference, so a repeated confirmation never credits twice.
 */

const topUpTtlMs = 60 * 60_000;
const usage = "用法：/topup 邮箱 金额，例如 /topup agent@example.com 300";
const argsPattern = /^(\S+@\S+)\s+(\d{1,5}(?:\.\d{1,2})?)$/;

const targetSchema = z.object({
	user_id: z.number().int().positive(),
	email: z.string(),
	partner_type: z.enum(["reseller", "api_credential"]),
	balance: z.string(),
});
const resultSchema = targetSchema.extend({
	transaction_id: z.number().int().positive(),
	amount: z.string(),
	balance_before: z.string(),
	balance_after: z.string(),
	duplicate: z.boolean(),
});
const payloadSchema = z.object({
	email: z.string(),
	amount: z.string(),
	requestRef: z.string(),
});

const partnerLabel = { reseller: "子站代理", api_credential: "卡网 API" };

export async function topUpCommand(
	context: OwnerActionContext & { fetcher?: typeof fetch },
	args: string,
) {
	const match = argsPattern.exec(args);
	if (!match) return usage;
	const [, email = "", amountText = ""] = match;
	const amountMinor = toMinor(amountText);
	if (amountMinor <= 0 || amountMinor > 5_000_000)
		return "金额要大于 0、不超过 50000";
	let target: z.infer<typeof targetSchema>;
	try {
		target = await requestProgram(
			context.agentProgramToken,
			"wallet-topups/preview",
			targetSchema,
			"POST",
			{ email },
			context.fetcher,
		);
	} catch {
		return `⚠️ 找不到可充值的代理账号：${email}（需要唯一的 active 账号，且是子站代理或已开通的卡网 API）`;
	}
	const amount = formatMinor(amountMinor);
	const after = formatMinor(toMinor(target.balance) + amountMinor);
	await proposeOwnerAction(context.db, {
		kind: "agent_wallet_topup",
		payload: {
			email: target.email,
			amount,
			requestRef: requestRef(context.now),
		} satisfies z.infer<typeof payloadSchema>,
		text: [
			"💰 代理钱包充值确认",
			`账号：${target.email}（${partnerLabel[target.partner_type]}）`,
			`当前余额：¥${target.balance}`,
			`充值：¥${amount} → 充值后约 ¥${after}`,
			"1 小时内有效。",
		].join("\n"),
		choices: [`✅ 确认充值 ¥${amount}`],
		rejectLabel: "❌ 取消",
		fallback: null,
		ttlMs: topUpTtlMs,
		now: context.now,
		fetcher: context.fetcher,
	});
	return null;
}

export async function approveWalletTopUp(
	context: OwnerActionContext & { fetcher?: typeof fetch },
	rawPayload: unknown,
) {
	const payload = payloadSchema.parse(rawPayload);
	let result: z.infer<typeof resultSchema>;
	try {
		result = await requestProgram(
			context.agentProgramToken,
			"wallet-topups",
			resultSchema,
			"POST",
			{
				email: payload.email,
				amount: payload.amount,
				request_ref: payload.requestRef,
				operator: `telegram:${context.decidedBy ?? "owner"}`,
			},
			context.fetcher,
		);
	} catch {
		// Safe to retry: the same request number never credits twice.
		throw new DomainError(
			"wallet_topup_failed",
			502,
			`代理站没有确认入账（单号 ${payload.requestRef}）。可再点一次确认重试，不会重复入账`,
		);
	}
	return `✅ 已充值 ¥${result.amount}：余额 ¥${result.balance_before} → ¥${result.balance_after}（流水 #${result.transaction_id}${result.duplicate ? "，此前已入账，本次未重复" : ""}）`;
}

function requestRef(now: number) {
	const clock = beijingClock(now);
	const time = new Date(now + 8 * 3_600_000).toISOString().slice(11, 16);
	const random = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `TG-${clock.day.replaceAll("-", "")}${time.replace(":", "")}-${random}`;
}

function toMinor(value: string) {
	const [whole = "0", fraction = ""] = value.split(".");
	return Number(whole) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
}

function formatMinor(minor: number) {
	return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}
