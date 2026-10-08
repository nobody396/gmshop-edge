import { refundEntitlementGrantStatements } from "#/features/entitlements/server/ledger";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";

export async function promotionRefundSplit(
	db: D1Database,
	orderId: string,
	amountMinor: string,
) {
	const order = await db
		.prepare(`SELECT o.id,o.status,o.version,o.paid_minor,o.referral_reward_minor,
  h.cash_minor,h.reward_minor,h.external_minor FROM shop_orders o LEFT JOIN order_balance_holds h ON h.order_id=o.id AND h.state='consumed'
  WHERE o.id=?`)
		.bind(orderId)
		.first<{
			id: string;
			status: string;
			version: number;
			paid_minor: string;
			referral_reward_minor: string;
			cash_minor: string | null;
			reward_minor: string | null;
			external_minor: string | null;
		}>();
	if (!order) return null;
	const refunded = await db
		.prepare(`SELECT amount_minor,cash_return_minor,reward_return_minor,referral_reversal_minor FROM refunds
  WHERE order_id=? AND status='succeeded'`)
		.bind(orderId)
		.all<{
			amount_minor: string;
			cash_return_minor: string;
			reward_return_minor: string;
			referral_reversal_minor: string;
		}>();
	const sum = (key: keyof (typeof refunded.results)[number]) =>
		refunded.results.reduce((s, r) => s + BigInt(r[key]), 0n);
	const paid = BigInt(order.paid_minor),
		before = sum("amount_minor"),
		delta = BigInt(amountMinor);
	if (paid <= 0n || delta <= 0n || before + delta > paid)
		throw new DomainError(
			"refund_amount_exceeded",
			409,
			"Refund amount exceeds the remaining paid amount",
		);
	const fraction = (
		original: string | null,
		key: keyof (typeof refunded.results)[number],
	) => (BigInt(original ?? "0") * (before + delta)) / paid - sum(key);
	const cashRemaining =
		BigInt(order.cash_minor ?? "0") - sum("cash_return_minor");
	const rewardRemaining =
		BigInt(order.reward_minor ?? "0") - sum("reward_return_minor");
	const remaining = paid - before;
	const parts = [
		cashRemaining,
		rewardRemaining,
		remaining - cashRemaining - rewardRemaining,
	].map((amount, index) => ({
		index,
		amount: (amount * delta) / remaining,
		remainder: (amount * delta) % remaining,
	}));
	let cents = delta - parts.reduce((total, part) => total + part.amount, 0n);
	for (const part of [...parts].sort((a, b) =>
		a.remainder === b.remainder
			? a.index - b.index
			: a.remainder > b.remainder
				? -1
				: 1,
	)) {
		if (cents === 0n) break;
		part.amount += 1n;
		cents -= 1n;
	}
	const cash = parts[0]?.amount ?? 0n,
		reward = parts[1]?.amount ?? 0n;
	const reversal = fraction(
		order.referral_reward_minor,
		"referral_reversal_minor",
	);
	return {
		order,
		cash: cash.toString(),
		reward: reward.toString(),
		external: (delta - cash - reward).toString(),
		reversal: reversal.toString(),
		after: before + delta,
		allocated: order.external_minor !== null,
	};
}

export async function refundAllocatedBalance(
	db: D1Database,
	input: {
		orderId: string;
		amountMinor: string;
		idempotencyKey: string;
		reason: string;
	},
	context: { actorUserId: string; request: Request },
	split: NonNullable<Awaited<ReturnType<typeof promotionRefundSplit>>>,
) {
	const { order } = split;
	if (
		!["paid", "fulfilling", "completed", "failed"].includes(order.status) ||
		split.external !== "0"
	)
		throw new DomainError(
			"refund_order_unavailable",
			409,
			"Order cannot be refunded from balance",
		);
	const now = Date.now(),
		id = crypto.randomUUID(),
		version = order.version + 1;
	const status =
		split.after === BigInt(order.paid_minor) ? "refunded" : order.status;
	const result = await db.batch([
		db
			.prepare(`UPDATE shop_orders SET status=?,version=?,updated_at=?,refunded_at=CASE WHEN ?='refunded' THEN ? ELSE refunded_at END
   WHERE id=? AND version=? AND status=?`)
			.bind(
				status,
				version,
				now,
				status,
				now,
				order.id,
				order.version,
				order.status,
			),
		db
			.prepare(`INSERT INTO refunds(id,order_id,idempotency_key,amount_minor,currency,payment_amount_minor,payment_currency,
   payment_currency_decimals,order_status_before,status,reason,requested_by,completed_at,created_at,updated_at,
   cash_return_minor,reward_return_minor,referral_reversal_minor)
   SELECT ?,id,?,?,'CNY',?,'CNY',2,?,'succeeded',?,?,?,?,?,?,?,? FROM shop_orders WHERE id=? AND version=? AND changes()=1`)
			.bind(
				id,
				input.idempotencyKey,
				input.amountMinor,
				input.amountMinor,
				order.status,
				input.reason,
				context.actorUserId,
				now,
				now,
				now,
				split.cash,
				split.reward,
				split.reversal,
				order.id,
				version,
			),
		db
			.prepare(`INSERT INTO shop_order_events(id,order_id,event_type,visibility,from_status,to_status,order_version,actor_type,actor_user_id,created_at)
   SELECT ?,order_id,'refund_succeeded','customer',?,?,?,'admin',?,? FROM refunds WHERE id=?`)
			.bind(
				crypto.randomUUID(),
				order.status === status ? null : order.status,
				order.status === status ? null : status,
				version,
				context.actorUserId,
				now,
				id,
			),
		...(status === "refunded"
			? await refundEntitlementGrantStatements(db, order.id, now, {
					refundId: id,
					attempt: 0,
				})
			: []),
		createAuditStatement(db, context.request, context.actorUserId, {
			action: "refund.balance_succeeded",
			targetType: "refund",
			targetId: id,
			after: { orderId: order.id, amountMinor: input.amountMinor },
		}),
	]);
	if (Number(result[0]?.meta.changes ?? 0) < 1)
		throw new DomainError(
			"order_version_conflict",
			409,
			"Order changed; retry refund",
		);
	return { id, status: "succeeded" as const, duplicate: false };
}
