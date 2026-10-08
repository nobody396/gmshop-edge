import { DomainError } from "#/lib/domain-error";

export type BalanceHold = {
	order_id: string;
	user_id: string;
	cash_minor: string;
	reward_minor: string;
	external_minor: string;
	state: "held" | "consumed" | "released";
};
export async function reserveOrderBalance(
	db: D1Database,
	orderId: string,
	userId: string,
) {
	const existing = await db
		.prepare("SELECT * FROM order_balance_holds WHERE order_id=?")
		.bind(orderId)
		.first<BalanceHold>();
	if (existing) {
		if (existing.user_id !== userId || existing.state === "released")
			throw new DomainError(
				"wallet_hold_conflict",
				409,
				"Order balance reservation is unavailable",
			);
		return existing;
	}
	const order = await db
		.prepare(`SELECT o.total_minor,u.balance_minor,u.reward_balance_minor FROM shop_orders o
  JOIN users u ON u.id=o.user_id WHERE o.id=? AND o.user_id=? AND o.status='pending_payment' AND u.enabled=1`)
		.bind(orderId, userId)
		.first<{
			total_minor: string;
			balance_minor: string;
			reward_balance_minor: string;
		}>();
	if (!order)
		throw new DomainError(
			"order_not_payable",
			409,
			"Order cannot reserve balance",
		);
	const total = BigInt(order.total_minor),
		rewardAvailable =
			BigInt(order.reward_balance_minor) > 0n
				? BigInt(order.reward_balance_minor)
				: 0n;
	const reward = rewardAvailable < total ? rewardAvailable : total;
	const cash =
		BigInt(order.balance_minor) < total - reward
			? BigInt(order.balance_minor)
			: total - reward;
	if (cash + reward === 0n) return null;
	const now = Date.now();
	try {
		await db
			.prepare(`INSERT INTO order_balance_holds(order_id,user_id,cash_minor,reward_minor,external_minor,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?)`)
			.bind(
				orderId,
				userId,
				cash.toString(),
				reward.toString(),
				(total - cash - reward).toString(),
				now,
				now,
			)
			.run();
	} catch {
		const replay = await db
			.prepare(
				"SELECT * FROM order_balance_holds WHERE order_id=? AND user_id=? AND state<>'released'",
			)
			.bind(orderId, userId)
			.first<BalanceHold>();
		if (replay) return replay;
		throw new DomainError(
			"wallet_hold_conflict",
			409,
			"Balance changed; retry checkout",
		);
	}
	return {
		order_id: orderId,
		user_id: userId,
		cash_minor: cash.toString(),
		reward_minor: reward.toString(),
		external_minor: (total - cash - reward).toString(),
		state: "held" as const,
	};
}

export async function settlePromotionRewards(db: D1Database, now = Date.now()) {
	const rows = await db
		.prepare(`SELECT r.order_id FROM promotion_rewards r JOIN shop_orders o ON o.id=r.order_id
  JOIN users u ON u.id=r.user_id WHERE r.state='pending' AND r.available_at<=? AND o.status='completed' AND u.enabled=1
  ORDER BY r.available_at,r.order_id LIMIT 100`)
		.bind(now)
		.all<{ order_id: string }>();
	let settled = 0;
	for (const row of rows.results) {
		const result = await db
			.prepare(`UPDATE promotion_rewards SET state='available',updated_at=?
  WHERE order_id=? AND state='pending' AND available_at<=? AND EXISTS(SELECT 1 FROM shop_orders WHERE id=? AND status='completed') AND EXISTS(SELECT 1 FROM users WHERE id=promotion_rewards.user_id AND enabled=1)`)
			.bind(now, row.order_id, now, row.order_id)
			.run();
		settled += Number(Number(result.meta.changes ?? 0) > 0);
	}
	return { settled };
}

/** Safe only before any provider attempt exists; ambiguous external payments must keep their reservation. */
export async function cancelUnstartedBalancePayment(
	db: D1Database,
	orderId: string,
) {
	const now = Date.now();
	const result = await db
		.prepare(`UPDATE shop_orders SET status='cancelled',cancelled_at=?,updated_at=?,version=version+1
  WHERE id=? AND status='pending_payment'
   AND EXISTS(SELECT 1 FROM order_balance_holds WHERE order_id=shop_orders.id AND state='held')
   AND NOT EXISTS(SELECT 1 FROM payment_attempts WHERE order_id=shop_orders.id)`)
		.bind(now, now, orderId)
		.run();
	return Number(result.meta.changes ?? 0) > 0;
}
