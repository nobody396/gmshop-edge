import { completeManualDelivery } from "#/features/fulfillment/server/process";
import { loadSettings } from "#/features/ops-automation/server/shared";
import {
	beijingMinute,
	claudeEnvSettingKeys,
	claudeEnvTrafficSkuIds,
	claudeEnvTrafficSkus,
	dayMs,
	formatGb,
	gbBytes,
	iproyalIncludedBytes,
	maskEmail,
	type TrafficNoticeThreshold,
	trafficLevel,
	trafficNoticeThresholds,
	trafficPeriodMs,
	trafficPeriodStart,
	upstreamAlertBytes,
} from "../domain";
import {
	enqueueClaudeEnvTrafficEmail,
	type SendTrafficEmail,
	trafficPercentText,
} from "./customer-email";
import { activeClaudeEnvSubscription } from "./eligibility";
import {
	type Deliver,
	defaultDeliver,
	eventStatement,
	resolveBuyer,
} from "./shared";

/**
 * Traffic add-ons, usage notices and the upstream-capacity contract with the
 * IPRoyal buyer CLI. Entitlement of a period = traffic_quota_bytes (base) +
 * applied add-ons of that period; a new period therefore starts at the base.
 */

export type TrafficContext = {
	db: D1Database;
	now: number;
	deliver: Deliver;
	sendTrafficEmail?: SendTrafficEmail;
};

const say = (context: TrafficContext, text: string) =>
	context.deliver(text).catch(() => undefined);

// ---------- period snapshot ----------

export type TrafficRow = {
	id: string;
	activated_at: number | null;
	traffic_period_start: number | null;
	traffic_period_bytes: number;
	traffic_quota_bytes: number;
};

export type TrafficSnapshot = {
	periodStart: number;
	periodEnd: number;
	usedBytes: number;
	baseBytes: number;
	addonBytes: number;
	entitledBytes: number;
	upstreamPurchasedBytes: number;
	upstreamCapacityBytes: number;
};

/** Current period of an activated subscription and the relay-measured usage in it. */
export function periodUsage(row: TrafficRow, now: number) {
	if (row.activated_at === null) return null;
	const periodStart = trafficPeriodStart(row.activated_at, now);
	return {
		periodStart,
		periodEnd: periodStart + trafficPeriodMs,
		// The relay rolls traffic_period_start over on its next report; until
		// then a stale counter belongs to the previous period.
		usedBytes:
			row.traffic_period_start === periodStart ? row.traffic_period_bytes : 0,
	};
}

/** Entitlement and upstream capacity of each subscription's current period. */
export async function trafficSnapshots(
	db: D1Database,
	rows: TrafficRow[],
	now: number,
) {
	const snapshots = new Map<string, TrafficSnapshot>();
	if (!rows.length) return snapshots;
	// Only the current periods matter: anything older than one period is skipped.
	const since = now - trafficPeriodMs - dayMs;
	const [addons, purchases] = await db.batch<{
		subscription_id: string;
		period_start: number;
		bytes: number;
	}>([
		db
			.prepare(
				`SELECT subscription_id, period_start, SUM(bytes) AS bytes FROM claude_env_traffic_addons
				 WHERE status = 'applied' AND period_start >= ? GROUP BY subscription_id, period_start`,
			)
			.bind(since),
		db
			.prepare(
				`SELECT subscription_id, period_start, SUM(bytes) AS bytes FROM claude_env_upstream_purchases
				 WHERE subscription_id IS NOT NULL AND period_start >= ? GROUP BY subscription_id, period_start`,
			)
			.bind(since),
	]);
	const key = (id: string, start: number) => `${id}:${start}`;
	const sum = (result: typeof addons) =>
		new Map(
			(result?.results ?? []).map((r) => [
				key(r.subscription_id, r.period_start),
				Number(r.bytes),
			]),
		);
	const addonBytes = sum(addons);
	const purchasedBytes = sum(purchases);
	for (const row of rows) {
		const usage = periodUsage(row, now);
		if (!usage) continue;
		const addon = addonBytes.get(key(row.id, usage.periodStart)) ?? 0;
		const purchased = purchasedBytes.get(key(row.id, usage.periodStart)) ?? 0;
		snapshots.set(row.id, {
			...usage,
			baseBytes: row.traffic_quota_bytes,
			addonBytes: addon,
			entitledBytes: row.traffic_quota_bytes + addon,
			upstreamPurchasedBytes: purchased,
			upstreamCapacityBytes: iproyalIncludedBytes + purchased,
		});
	}
	return snapshots;
}

export async function snapshotOf(
	db: D1Database,
	subscriptionId: string,
	now: number,
) {
	const row = await db
		.prepare(
			"SELECT id, activated_at, traffic_period_start, traffic_period_bytes, traffic_quota_bytes FROM claude_env_subscriptions WHERE id = ?",
		)
		.bind(subscriptionId)
		.first<TrafficRow>();
	return row ? (await trafficSnapshots(db, [row], now)).get(row.id) : undefined;
}

// ---------- paid add-on orders ----------

type AddonItem = {
	order_item_id: string;
	order_id: string;
	order_number: string;
	sellable_item_id: string;
	quantity: number;
	user_id: string | null;
	user_email: string | null;
	contact_email: string | null;
	locale: string | null;
	via_api: number;
};

const addonColumns = `oi.id AS order_item_id, oi.order_id, o.order_number, oi.sellable_item_id, oi.quantity,
 o.user_id, u.email AS user_email, o.normalized_contact_email AS contact_email, o.locale,
 EXISTS(SELECT 1 FROM supplier_api_orders sa WHERE sa.shop_order_id = o.id) AS via_api`;
const addonFrom = `FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
 LEFT JOIN users u ON u.id = o.user_id`;
const skuList = claudeEnvTrafficSkuIds.map(() => "?").join(",");

export async function ingestTrafficAddons(
	context: TrafficContext,
	ingestAfter: number,
) {
	const rows = await context.db
		.prepare(
			`SELECT ${addonColumns} ${addonFrom}
			 WHERE oi.sellable_item_id IN (${skuList})
			 AND o.status IN ('paid','fulfilling','completed') AND o.paid_at >= ?
			 AND NOT EXISTS (SELECT 1 FROM claude_env_traffic_addons a WHERE a.order_item_id = oi.id)
			 ORDER BY o.paid_at, oi.id LIMIT 20`,
		)
		.bind(...claudeEnvTrafficSkuIds, ingestAfter)
		.all<AddonItem>();
	const outcome = { applied: 0, waiting: 0, skipped: 0, duplicate: 0 };
	for (const row of rows.results)
		outcome[await processAddon(context, row)] += 1;
	return outcome;
}

/**
 * The buyer opened the add-on order page: apply it now instead of waiting for
 * the next minute's cron (same rules, same idempotent claim).
 */
export async function ingestTrafficForOrder(
	db: D1Database,
	userId: string,
	orderNumber: string,
	now: number,
	deliver?: Deliver,
) {
	const settings = await loadSettings(db, [
		claudeEnvSettingKeys.enabled,
		claudeEnvSettingKeys.ingestAfter,
	]);
	const ingestAfter = settings.get(claudeEnvSettingKeys.ingestAfter);
	if (
		settings.get(claudeEnvSettingKeys.enabled) !== true ||
		typeof ingestAfter !== "number"
	)
		return 0;
	const rows = await db
		.prepare(
			`SELECT ${addonColumns} ${addonFrom}
			 WHERE o.order_number = ? AND o.user_id = ? AND oi.sellable_item_id IN (${skuList})
			 AND o.status IN ('paid','fulfilling','completed') AND o.paid_at >= ?
			 AND NOT EXISTS (SELECT 1 FROM claude_env_traffic_addons a WHERE a.order_item_id = oi.id)
			 LIMIT 5`,
		)
		.bind(orderNumber, userId, ...claudeEnvTrafficSkuIds, ingestAfter)
		.all<AddonItem>();
	if (!rows.results.length) return 0;
	const context: TrafficContext = {
		db,
		now,
		deliver: deliver ?? defaultDeliver(db, fetch),
	};
	let applied = 0;
	for (const row of rows.results)
		if ((await processAddon(context, row)) === "applied") applied += 1;
	return applied;
}

function addonInsert(
	db: D1Database,
	row: AddonItem,
	input: {
		subscriptionId: string | null;
		status: "applied" | "waiting" | "skipped";
		gb: number;
		units: number;
		periodStart: number | null;
		note?: string | null;
		now: number;
	},
) {
	return db
		.prepare(
			`INSERT INTO claude_env_traffic_addons
			 (order_item_id, order_id, subscription_id, status, gb, units, bytes, period_start, note, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(order_item_id) DO NOTHING`,
		)
		.bind(
			row.order_item_id,
			row.order_id,
			input.subscriptionId,
			input.status,
			input.gb,
			input.units,
			input.gb * input.units * gbBytes,
			input.periodStart,
			input.note ?? null,
			input.now,
			input.now,
		);
}

async function processAddon(
	context: TrafficContext,
	row: AddonItem,
): Promise<"applied" | "waiting" | "skipped" | "duplicate"> {
	const { db, now } = context;
	const sku = claudeEnvTrafficSkus[row.sellable_item_id];
	if (!sku) return "skipped";
	const units = Math.max(1, row.quantity);
	const tier = `${sku.label}${units > 1 ? ` ×${units}` : ""}`;
	const base = { gb: sku.gb, units, now };
	const park = async (
		status: "waiting" | "skipped",
		note: string,
		text: string,
	) => {
		const result = await addonInsert(db, row, {
			...base,
			subscriptionId: null,
			status,
			periodStart: null,
			note,
		}).run();
		if (Number(result.meta.changes ?? 0) !== 1) return "duplicate" as const;
		await say(context, text);
		return status;
	};
	if (row.via_api)
		return park(
			"skipped",
			"via_api",
			`⚠️ Claude 专属环境加流量订单需要人工处理\n订单 ${row.order_number}｜${tier}\n原因：代理站经供货 API 下的单，系统不知道最终客户，没有自动加流量。`,
		);
	const buyer = await resolveBuyer(db, row);
	if (!buyer)
		return park(
			"waiting",
			"guest",
			`⚠️ Claude 专属环境加流量游客订单 ${row.order_number}（${tier}）：客户还没用下单邮箱注册/验证主站账号。客户登录并验证后，如果有正在使用的专属环境，系统会自动加上。`,
		);
	const sub = await activeClaudeEnvSubscription(db, buyer.userId, now);
	if (!sub)
		return park(
			"skipped",
			"no_active_subscription",
			`⚠️ Claude 专属环境加流量订单需要人工处理\n订单 ${row.order_number}｜客户 ${maskEmail(buyer.email)}｜${tier}\n原因：客户没有正在使用的专属环境（还没开通好或已到期），系统没有加流量。请联系客户或退款。`,
		);
	const periodStart = trafficPeriodStart(sub.activated_at, now);
	const claim = await addonInsert(db, row, {
		...base,
		subscriptionId: sub.id,
		status: "applied",
		periodStart,
	}).run();
	if (Number(claim.meta.changes ?? 0) !== 1) return "duplicate";
	const snapshot = await snapshotOf(db, sub.id, now);
	const used = snapshot?.usedBytes ?? 0;
	const entitled = snapshot?.entitledBytes ?? 0;
	const added = sku.gb * units * gbBytes;
	await db.batch([
		// A threshold the new entitlement is no longer above can be crossed (and
		// notified) again; one still above stays as sent.
		db
			.prepare(
				`DELETE FROM claude_env_traffic_notices WHERE subscription_id = ? AND period_start = ?
				 AND kind IN ('p7500','p9000','p9750') AND ? * 10000 < ? * CAST(substr(kind, 2) AS INTEGER)`,
			)
			.bind(sub.id, periodStart, used, entitled),
		eventStatement(
			db,
			sub.id,
			"traffic_added",
			`+${formatGb(added)}（订单 ${row.order_number}，本期 ${formatGb(entitled)}）`,
			now,
		),
	]);
	await completeAddonDelivery(db, {
		order_item_id: row.order_item_id,
		gb: sku.gb,
		units,
		period_start: periodStart,
		locale: row.locale,
	});
	await say(
		context,
		[
			"➕ Claude 专属环境加流量（已付款，已生效）",
			`订单 ${row.order_number}｜客户 ${maskEmail(sub.email)}`,
			`档位 ${tier}（+${formatGb(added)}，只在本期有效）`,
			`IPRoyal 订单 #${sub.iproyal_order_id ?? "?"}｜IP ${sub.ip ?? "?"}`,
			`本期已用 ${formatGb(used)} / 客户应得 ${formatGb(entitled)}（基础 ${formatGb(snapshot?.baseBytes ?? 0)} + 加购 ${formatGb(snapshot?.addonBytes ?? 0)}），${beijingMinute(periodStart + trafficPeriodMs)} 结束`,
			`IPRoyal 本期容量 ${formatGb(snapshot?.upstreamCapacityBytes ?? iproyalIncludedBytes)}（含 100 GB + 已买 ${formatGb(snapshot?.upstreamPurchasedBytes ?? 0)}）。自动采购会在 IPRoyal 用量 ≥85% 时补买，不用手动买。`,
		].join("\n"),
	);
	return "applied";
}

const deliveryCopy = {
	"zh-CN": (gb: string, end: string) =>
		`已为你的 Claude 专属环境增加 ${gb} 流量，本期有效（到 ${end} 北京时间为止，不累积到下一期）。可以在订单页「Claude 专属环境」里看到本期流量。`,
	"en-US": (gb: string, end: string) =>
		`${gb} of traffic has been added to your dedicated Claude environment for the current period (until ${end} Beijing time; it does not carry over). See this period's traffic under "Claude dedicated environment" on your order page.`,
} as const;

/** Marks the add-on order item delivered (manual fulfillment, no stock). */
async function completeAddonDelivery(
	db: D1Database,
	addon: {
		order_item_id: string;
		gb: number;
		units: number;
		period_start: number | null;
		locale: string | null;
	},
) {
	const deliveries = await db
		.prepare(
			"SELECT id, status FROM delivery_records WHERE order_item_id = ? ORDER BY created_at, id",
		)
		.bind(addon.order_item_id)
		.all<{ id: string; status: string }>();
	const copy =
		deliveryCopy[addon.locale === "en-US" ? "en-US" : ("zh-CN" as const)];
	const content = copy(
		formatGb(addon.gb * addon.units * gbBytes),
		addon.period_start === null
			? "—"
			: beijingMinute(addon.period_start + trafficPeriodMs),
	);
	let error: string | null = null;
	for (const delivery of deliveries.results) {
		if (!["awaiting_supply", "processing"].includes(delivery.status)) continue;
		try {
			await completeManualDelivery(db, delivery.id, content);
		} catch (cause) {
			error =
				cause && typeof cause === "object" && "code" in cause
					? String(cause.code)
					: "delivery_failed";
		}
	}
	await db
		.prepare(
			"UPDATE claude_env_traffic_addons SET delivered = ?, note = ?, updated_at = ? WHERE order_item_id = ?",
		)
		.bind(error ? 0 : 1, error, Date.now(), addon.order_item_id)
		.run();
	return error === null;
}

/** Retries order deliveries that could not be completed when the add-on was applied. */
export async function deliverTrafficAddons(context: TrafficContext) {
	const rows = await context.db
		.prepare(
			`SELECT a.order_item_id, a.gb, a.units, a.period_start, o.locale FROM claude_env_traffic_addons a
			 JOIN shop_orders o ON o.id = a.order_id
			 WHERE a.status = 'applied' AND a.delivered = 0 ORDER BY a.created_at LIMIT 20`,
		)
		.all<{
			order_item_id: string;
			gb: number;
			units: number;
			period_start: number | null;
			locale: string | null;
		}>();
	let delivered = 0;
	for (const row of rows.results)
		if (await completeAddonDelivery(context.db, row)) delivered += 1;
	return delivered;
}

/** Guests who registered since are applied; unpaid ones are dropped. */
export async function promoteWaitingAddons(context: TrafficContext) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT ${addonColumns}, o.status AS order_status ${addonFrom}
			 JOIN claude_env_traffic_addons a ON a.order_item_id = oi.id
			 WHERE a.status = 'waiting' ORDER BY a.created_at LIMIT 50`,
		)
		.all<AddonItem & { order_status: string }>();
	let promoted = 0;
	for (const row of rows.results) {
		if (!["paid", "fulfilling", "completed"].includes(row.order_status)) {
			await db
				.prepare(
					"UPDATE claude_env_traffic_addons SET status = 'skipped', note = ?, updated_at = ? WHERE order_item_id = ? AND status = 'waiting'",
				)
				.bind(`order_${row.order_status}`, now, row.order_item_id)
				.run();
			continue;
		}
		if (!(await resolveBuyer(db, row))) continue;
		const removed = await db
			.prepare(
				"DELETE FROM claude_env_traffic_addons WHERE order_item_id = ? AND status = 'waiting'",
			)
			.bind(row.order_item_id)
			.run();
		if (Number(removed.meta.changes ?? 0) !== 1) continue;
		await processAddon(context, row);
		promoted += 1;
	}
	return promoted;
}

/** A refunded add-on stops counting toward the period's entitlement. */
export async function handleTrafficAddonRefunds(context: TrafficContext) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT a.order_item_id, a.subscription_id, a.status, a.gb, a.units, o.order_number
			 FROM claude_env_traffic_addons a JOIN shop_orders o ON o.id = a.order_id
			 WHERE o.status = 'refunded' AND a.refund_handled = 0 LIMIT 20`,
		)
		.all<{
			order_item_id: string;
			subscription_id: string | null;
			status: string;
			gb: number;
			units: number;
			order_number: string;
		}>();
	for (const row of rows.results) {
		const wasApplied = row.status === "applied";
		await db.batch([
			db
				.prepare(
					`UPDATE claude_env_traffic_addons SET refund_handled = 1, updated_at = ?,
					 status = CASE WHEN status IN ('applied','waiting') THEN 'refunded' ELSE status END
					 WHERE order_item_id = ?`,
				)
				.bind(now, row.order_item_id),
			eventStatement(
				db,
				row.subscription_id,
				"traffic_refunded",
				`订单 ${row.order_number} 已退款`,
				now,
			),
		]);
		if (wasApplied)
			await say(
				context,
				`ℹ️ Claude 专属环境加流量订单 ${row.order_number} 已退款：已从客户本期流量里扣回 ${formatGb(row.gb * row.units * gbBytes)}。IPRoyal 已经加买的流量不会退。`,
			);
	}
	return rows.results.length;
}

// ---------- usage notices ----------

type NoticeRow = TrafficRow & {
	user_id: string;
	email: string;
	account_email: string | null;
	iproyal_order_id: string | null;
	ip: string | null;
	order_number: string | null;
	order_locale: string | null;
};

const noticeKind = (bps: TrafficNoticeThreshold) => `p${bps}` as const;

/**
 * Customer emails at 75% / 90% / 97.5% of the period's entitlement (one per
 * threshold per period; a jump across several sends only the highest), plus
 * the owner safety net when relay usage passes 85 GB and the buyer CLI has not
 * reported an upstream purchase this period.
 */
export async function sendTrafficNotices(context: TrafficContext) {
	const { db, now } = context;
	const sendEmail = context.sendTrafficEmail ?? enqueueClaudeEnvTrafficEmail;
	const rows = await db
		.prepare(
			`SELECT s.id, s.user_id, s.email, s.activated_at, s.traffic_period_start, s.traffic_period_bytes,
			 s.traffic_quota_bytes, s.iproyal_order_id, s.ip, u.email AS account_email,
			 o.order_number, o.locale AS order_locale
			 FROM claude_env_subscriptions s
			 LEFT JOIN users u ON u.id = s.user_id
			 LEFT JOIN shop_orders o ON o.id = s.order_id
			 WHERE s.status = 'active' AND s.activated_at IS NOT NULL
			 AND (s.traffic_period_bytes >= ? OR s.traffic_period_bytes * 4 >= s.traffic_quota_bytes * 3)
			 ORDER BY s.traffic_period_bytes DESC LIMIT 100`,
		)
		.bind(upstreamAlertBytes)
		.all<NoticeRow>();
	const snapshots = await trafficSnapshots(db, rows.results, now);
	const outcome = { customer: 0, owner: 0 };
	for (const row of rows.results) {
		const snapshot = snapshots.get(row.id);
		if (!snapshot || snapshot.usedBytes === 0) continue;
		if (await notifyCustomer(context, sendEmail, row, snapshot))
			outcome.customer += 1;
		if (await alertUnbought(context, row, snapshot)) outcome.owner += 1;
	}
	return outcome;
}

async function notifyCustomer(
	context: TrafficContext,
	sendEmail: SendTrafficEmail,
	row: NoticeRow,
	snapshot: TrafficSnapshot,
) {
	const { db, now } = context;
	const level = trafficLevel(snapshot.usedBytes, snapshot.entitledBytes);
	if (level === null || !row.order_number) return false;
	const claim = await db
		.prepare(
			`INSERT INTO claude_env_traffic_notices (subscription_id, period_start, kind, entitled_bytes, used_bytes, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'sending', ?, ?) ON CONFLICT DO NOTHING`,
		)
		.bind(
			row.id,
			snapshot.periodStart,
			noticeKind(level),
			snapshot.entitledBytes,
			snapshot.usedBytes,
			now,
			now,
		)
		.run();
	if (Number(claim.meta.changes ?? 0) !== 1) return false;
	// Lower thresholds crossed in the same jump are covered by this notice.
	const lower = trafficNoticeThresholds.filter((bps) => bps < level);
	if (lower.length)
		await db.batch(
			lower.map((bps) =>
				db
					.prepare(
						`INSERT INTO claude_env_traffic_notices (subscription_id, period_start, kind, entitled_bytes, used_bytes, status, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, 'superseded', ?, ?) ON CONFLICT DO NOTHING`,
					)
					.bind(
						row.id,
						snapshot.periodStart,
						noticeKind(bps),
						snapshot.entitledBytes,
						snapshot.usedBytes,
						now,
						now,
					),
			),
		);
	let status: "sent" | "skipped" | "failed";
	let detail: string;
	try {
		const result = await sendEmail(db, {
			subscriptionId: row.id,
			to: (row.account_email ?? row.email).trim().toLowerCase(),
			orderNumber: row.order_number,
			threshold: level,
			periodStart: snapshot.periodStart,
			periodEnd: snapshot.periodEnd,
			usedBytes: snapshot.usedBytes,
			entitledBytes: snapshot.entitledBytes,
			locale: row.order_locale === "en-US" ? "en-US" : "zh-CN",
		});
		status = result.status === "queued" ? "sent" : "skipped";
		detail = JSON.stringify(result);
	} catch (error) {
		status = "failed";
		detail = error instanceof Error ? error.message.slice(0, 120) : "error";
	}
	await db.batch([
		db
			.prepare(
				"UPDATE claude_env_traffic_notices SET status = ?, detail = ?, updated_at = ? WHERE subscription_id = ? AND period_start = ? AND kind = ?",
			)
			.bind(
				status,
				detail,
				now,
				row.id,
				snapshot.periodStart,
				noticeKind(level),
			),
		eventStatement(
			db,
			row.id,
			"traffic_notice",
			`${trafficPercentText(level)}：已用 ${formatGb(snapshot.usedBytes)} / ${formatGb(snapshot.entitledBytes)}，邮件 ${status}`,
			now,
		),
	]);
	return true;
}

async function alertUnbought(
	context: TrafficContext,
	row: NoticeRow,
	snapshot: TrafficSnapshot,
) {
	const { db, now } = context;
	if (
		!row.iproyal_order_id ||
		snapshot.usedBytes < upstreamAlertBytes ||
		snapshot.entitledBytes <= iproyalIncludedBytes ||
		snapshot.upstreamPurchasedBytes > 0
	)
		return false;
	const claim = await db
		.prepare(
			`INSERT INTO claude_env_traffic_notices (subscription_id, period_start, kind, entitled_bytes, used_bytes, status, created_at, updated_at)
			 VALUES (?, ?, 'owner_unbought', ?, ?, 'sent', ?, ?) ON CONFLICT DO NOTHING`,
		)
		.bind(
			row.id,
			snapshot.periodStart,
			snapshot.entitledBytes,
			snapshot.usedBytes,
			now,
			now,
		)
		.run();
	if (Number(claim.meta.changes ?? 0) !== 1) return false;
	await say(
		context,
		[
			`⚠️ 客户 ${maskEmail(row.account_email ?? row.email)} 已用 ${formatGb(snapshot.usedBytes)}，IPRoyal 订单 #${row.iproyal_order_id} 需要加流量，自动采购还没回报。`,
			`IP ${row.ip ?? "?"}｜本期客户应得 ${formatGb(snapshot.entitledBytes)}，IPRoyal 本期容量 ${formatGb(snapshot.upstreamCapacityBytes)}（只含自带 100 GB）｜${beijingMinute(snapshot.periodEnd)} 结束`,
			"请确认流量采购程序在运行；或在 IPRoyal 后台给这个订单加流量（用量 ≥85% 才能买），买完让程序回报一次。",
		].join("\n"),
	);
	return true;
}
