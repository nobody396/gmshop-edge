import {
	claimInterval,
	settingStatement,
} from "#/features/ops-automation/server/shared";
import { claudeEnvSettingKeys, dayMs, parseIproyalDate } from "../domain";
import {
	createIproyalClient,
	type IproyalClient,
	type IproyalOrderSummary,
} from "./iproyal";
import { type Deliver, defaultDeliver } from "./shared";

/**
 * IPRoyal order reconciliation (2026-10-26, after an order nobody could
 * explain). Every ISP order on the account must be either a subscription's
 * `iproyal_order_id` or a row in `claude_env_known_orders`; anything else is
 * reported to the owner once. GET requests only, and it runs whether or not
 * the automation flag is on, as long as the Worker has the token.
 */
export const reconcileIntervalMs = 10 * 60_000;
/** Refunded / expired orders cost nothing more, so they never alert. */
const inactiveStatuses = new Set(["refunded", "expired"]);
const lookupTimeoutMs = 10_000;
const alertOnceMs = 3650 * dayMs;

export type ReconcileInput = {
	db: D1Database;
	iproyalToken?: string;
	iproyal?: IproyalClient;
	now?: number;
	fetcher?: typeof fetch;
	deliver?: Deliver;
};

export type ReconciledOrder = IproyalOrderSummary & {
	/** Known label, `subscription <id>`, or null when nobody registered it. */
	known: string | null;
	/** expire_date minus the plan length when the order was never extended. */
	estimatedCreatedAt: number | null;
};

export type ReconcileSnapshot = {
	checkedAt: number;
	orders: ReconciledOrder[];
};

export async function reconcileIproyalOrders(input: ReconcileInput) {
	const now = input.now ?? Date.now();
	const fetcher = input.fetcher ?? fetch;
	const iproyal =
		input.iproyal ??
		(input.iproyalToken
			? createIproyalClient(input.iproyalToken, fetcher)
			: null);
	if (!iproyal) return { status: "no_token" as const };
	const { db } = input;
	if (
		!(await claimInterval(
			db,
			claudeEnvSettingKeys.reconcileAt,
			now,
			reconcileIntervalMs,
		))
	)
		return { status: "skipped" as const };
	const deliver = input.deliver ?? defaultDeliver(db, fetcher);
	const [orders, subscriptions, registered, pending] = await Promise.all([
		iproyal.listOrders(),
		db
			.prepare(
				"SELECT id, iproyal_order_id FROM claude_env_subscriptions WHERE iproyal_order_id IS NOT NULL",
			)
			.all<{ id: string; iproyal_order_id: string }>(),
		db
			.prepare("SELECT order_id, label FROM claude_env_known_orders")
			.all<{ order_id: string; label: string }>(),
		db
			.prepare(
				"SELECT COUNT(*) AS count FROM claude_env_subscriptions WHERE iproyal_order_state IN ('posting','unknown') AND iproyal_order_id IS NULL",
			)
			.first<{ count: number }>(),
	]);
	const known = new Map<string, string>();
	for (const row of registered.results) known.set(row.order_id, row.label);
	for (const row of subscriptions.results)
		known.set(row.iproyal_order_id, `订阅 ${row.id}`);
	const reconciled: ReconciledOrder[] = orders.map((order) => ({
		...order,
		known: known.get(order.id) ?? null,
		estimatedCreatedAt: estimateCreatedAt(order),
	}));
	await settingStatement(
		db,
		claudeEnvSettingKeys.reconcileSnapshot,
		{ checkedAt: now, orders: reconciled } satisfies ReconcileSnapshot,
		now,
	).run();
	let alerted = 0;
	const unknown = reconciled.filter(
		(order) => order.known === null && !inactiveStatuses.has(order.status),
	);
	for (const order of unknown) {
		const key = `${claudeEnvSettingKeys.alertUnknownOrderPrefix}${order.id}`;
		// One alert per order id; a failed send releases the claim so the next
		// run (10 minutes later) tries again instead of losing the alert.
		if (!(await claimInterval(db, key, now, alertOnceMs))) continue;
		const city = order.ips[0] ? await lookupCity(order.ips[0], fetcher) : null;
		try {
			await deliver(
				unknownOrderAlert(order, city, Number(pending?.count ?? 0)),
			);
			alerted += 1;
		} catch {
			await db
				.prepare("DELETE FROM system_settings WHERE key = ?")
				.bind(key)
				.run()
				.catch(() => undefined);
		}
	}
	return {
		status: "ok" as const,
		orders: reconciled.length,
		unknown: unknown.length,
		alerted,
	};
}

export function estimateCreatedAt(order: IproyalOrderSummary) {
	if (order.extendedCount > 0) return null;
	const expires = parseIproyalDate(order.expireDate);
	const days = Number(/(\d+)\s*Day/i.exec(order.planName ?? "")?.[1]);
	if (expires === null || !Number.isInteger(days) || days <= 0) return null;
	return expires - days * dayMs;
}

const beijing = (ms: number) =>
	new Date(ms + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");

export function unknownOrderAlert(
	order: ReconciledOrder,
	city: string | null,
	pendingClaims: number,
) {
	return [
		"🚨 IPRoyal 出现一张系统不认识的订单（不是自动开通买的，也没有登记）",
		`订单 #${order.id}｜状态 ${order.status}`,
		`IP ${order.ips.join(", ") || "未分配"}${city ? `（${city}）` : ""}`,
		order.estimatedCreatedAt === null
			? `到期 ${order.expireDate ?? "?"}（UTC）`
			: `约 ${beijing(order.estimatedCreatedAt)} 下单（北京时间，按到期日倒推）`,
		`自动续费：${order.autoExtend ? "开" : "关"}｜套餐 ${order.planName ?? "?"}`,
		`备注：${order.note ?? "无"}`,
		pendingClaims > 0
			? `另有 ${pendingClaims} 个订阅下单结果不明，可能就是这一单：去后台「Claude 专属环境」核对后填订单号。`
			: "请去 IPRoyal 后台核对是谁买的；确认是自己买的就登记到 claude_env_known_orders。",
	].join("\n");
}

/** ip-api city/region; null when unreachable (the alert still goes out). */
async function lookupCity(ip: string, fetcher: typeof fetch) {
	try {
		const response = await fetcher(
			`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,city,regionName`,
			{ signal: AbortSignal.timeout(lookupTimeoutMs) },
		);
		if (!response.ok) return null;
		const value = (await response.json()) as {
			status?: unknown;
			city?: unknown;
			regionName?: unknown;
		};
		if (value?.status !== "success" || typeof value.city !== "string")
			return null;
		return typeof value.regionName === "string" && value.regionName
			? `${value.city}, ${value.regionName}`
			: value.city;
	} catch {
		return null;
	}
}

/** Latest snapshot for the admin page; null before the first run. */
export async function loadReconcileSnapshot(db: D1Database) {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key = ?")
		.bind(claudeEnvSettingKeys.reconcileSnapshot)
		.first<{ value: string }>();
	if (!row) return null;
	try {
		const value = JSON.parse(row.value) as ReconcileSnapshot;
		return Array.isArray(value?.orders) && typeof value.checkedAt === "number"
			? value
			: null;
	} catch {
		return null;
	}
}
