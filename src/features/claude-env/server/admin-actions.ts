import { z } from "zod";
import { DomainError } from "#/lib/domain-error";
import {
	canonicalTimezone,
	claudeEnvSettingKeys,
	defaultMaxCustomers,
	defaultMonthlyQuotaBytes,
	desiredStatuses,
	extendExpiry,
	maskEmail,
	relaySlotStatuses,
	staleClaimMs,
	timezoneForCity,
} from "../domain";
import { loadReconcileSnapshot } from "./reconcile";
import {
	type Crypt,
	eventStatement,
	lookupTimezone,
	secretPurpose,
} from "./shared";
import { trafficSnapshots } from "./traffic";

export type AdminActor = { userId: string; requestId?: string | null };

function audit(
	db: D1Database,
	actor: AdminActor,
	action: string,
	targetId: string,
	after: unknown,
	now: number,
) {
	return db
		.prepare(
			`INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, request_id, after, created_at)
			 VALUES (?, ?, ?, 'claude_env', ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			actor.userId,
			action,
			targetId,
			actor.requestId ?? null,
			JSON.stringify(after),
			now,
		);
}

type Nullable<T> = T | null;
export type AdminSubscriptionRow = {
	id: string;
	email: string;
	status: string;
	plan: string;
	ip: Nullable<string>;
	ip_city: Nullable<string>;
	ip_tz: Nullable<string>;
	relay_id: Nullable<string>;
	relay_port: Nullable<number>;
	iproyal_order_id: Nullable<string>;
	iproyal_order_state: Nullable<string>;
	iproyal_posting_at: Nullable<number>;
	expires_at: Nullable<number>;
	pending_days: number;
	activated_at: Nullable<number>;
	traffic_period_bytes: number;
	traffic_period_start: Nullable<number>;
	traffic_total_bytes: number;
	traffic_quota_bytes: number;
	last_check_at: Nullable<number>;
	last_exit_ok: Nullable<number>;
	last_anthropic_status: Nullable<number>;
	last_apply_error: Nullable<string>;
	last_error: Nullable<string>;
	qc_trust_score: Nullable<number>;
	qc_scam_score: Nullable<number>;
	qc_note: Nullable<string>;
	needs_replace_reason: Nullable<string>;
	created_at: number;
	order_number: Nullable<string>;
	upstream_used_bytes: Nullable<number>;
	upstream_used_at: Nullable<number>;
};
export type AdminRelayRow = {
	id: string;
	hostname: string;
	status: string;
	max_customers: number;
	monthly_quota_bytes: number;
	host_month: Nullable<string>;
	host_rx_bytes: number;
	host_tx_bytes: number;
	last_report_at: Nullable<number>;
	customers: number;
	live_customers: number;
};
export type AdminPeriodRow = {
	order_item_id: string;
	subscription_id: Nullable<string>;
	kind: string;
	days: number;
	units: number;
	units_extended: number;
	extend_status: string;
	extending_at: Nullable<number>;
	note: Nullable<string>;
	created_at: number;
	order_number: Nullable<string>;
};

export type AdminAddonRow = {
	order_item_id: string;
	subscription_id: Nullable<string>;
	status: string;
	gb: number;
	units: number;
	bytes: number;
	period_start: Nullable<number>;
	delivered: number;
	note: Nullable<string>;
	created_at: number;
	order_number: Nullable<string>;
};
export type AdminUpstreamPurchaseRow = {
	ref: string;
	iproyal_order_id: string;
	subscription_id: Nullable<string>;
	period_start: Nullable<number>;
	gb: number;
	cost_usd_cents: Nullable<number>;
	purchased_at: number;
};

// ---------- overview ----------

export async function loadClaudeEnvAdmin(db: D1Database, now: number) {
	const [flag, subs, relays, periods, iproyalOrders, addons, purchases] =
		await Promise.all([
			db
				.prepare("SELECT value FROM system_settings WHERE key = ?")
				.bind(claudeEnvSettingKeys.enabled)
				.first<{ value: string }>(),
			db
				.prepare(
					`SELECT s.id, s.email, s.status, s.plan, s.ip, s.ip_city, s.ip_tz, s.relay_id, s.relay_port,
				 s.iproyal_order_id, s.iproyal_order_state, s.iproyal_posting_at, s.expires_at, s.pending_days, s.activated_at,
				 s.traffic_period_bytes, s.traffic_period_start, s.traffic_total_bytes, s.traffic_quota_bytes,
				 s.last_check_at, s.last_exit_ok, s.last_anthropic_status, s.last_apply_error, s.last_error,
				 s.qc_trust_score, s.qc_scam_score, s.qc_note, s.needs_replace_reason, s.created_at, o.order_number,
				 s.upstream_used_bytes, s.upstream_used_at
				 FROM claude_env_subscriptions s LEFT JOIN shop_orders o ON o.id = s.order_id
				 ORDER BY CASE s.status WHEN 'needs_replace' THEN 0 WHEN 'awaiting_ip' THEN 1 WHEN 'provisioning' THEN 2 ELSE 3 END,
				 s.created_at DESC LIMIT 300`,
				)
				.all<AdminSubscriptionRow>(),
			db
				.prepare(
					`SELECT r.id, r.hostname, r.status, r.max_customers, r.monthly_quota_bytes, r.host_month,
				 r.host_rx_bytes, r.host_tx_bytes, r.last_report_at,
				 (SELECT COUNT(*) FROM claude_env_subscriptions s WHERE s.relay_id = r.id
				  AND s.status IN (${relaySlotStatuses.map(() => "?").join(",")})) AS customers,
				 (SELECT COUNT(*) FROM claude_env_subscriptions s WHERE s.relay_id = r.id
				  AND s.status IN (${desiredStatuses.map(() => "?").join(",")})) AS live_customers
				 FROM claude_env_relays r ORDER BY r.id`,
				)
				.bind(...relaySlotStatuses, ...desiredStatuses)
				.all<AdminRelayRow>(),
			db
				.prepare(
					`SELECT p.order_item_id, p.subscription_id, p.kind, p.days, p.units, p.units_extended, p.extend_status,
				 p.extending_at, p.note, p.created_at, o.order_number FROM claude_env_periods p LEFT JOIN shop_orders o ON o.id = p.order_id
				 WHERE p.extend_status IN ('failed','extending') OR p.kind IN ('skipped','waiting')
				 ORDER BY p.created_at DESC LIMIT 100`,
				)
				.all<AdminPeriodRow>(),
			loadReconcileSnapshot(db),
			db
				.prepare(
					`SELECT a.order_item_id, a.subscription_id, a.status, a.gb, a.units, a.bytes, a.period_start,
				 a.delivered, a.note, a.created_at, o.order_number FROM claude_env_traffic_addons a
				 LEFT JOIN shop_orders o ON o.id = a.order_id ORDER BY a.created_at DESC LIMIT 200`,
				)
				.all<AdminAddonRow>(),
			db
				.prepare(
					`SELECT ref, iproyal_order_id, subscription_id, period_start, gb, cost_usd_cents, purchased_at
				 FROM claude_env_upstream_purchases ORDER BY purchased_at DESC LIMIT 200`,
				)
				.all<AdminUpstreamPurchaseRow>(),
		]);
	const traffic = await trafficSnapshots(db, subs.results, now);
	return {
		now,
		iproyalOrders,
		enabled: flag?.value === "true",
		subscriptions: subs.results.map((row) => ({
			...row,
			email: maskEmail(row.email),
			reorderAllowed: reorderAllowed(row, now),
			traffic: traffic.get(row.id) ?? null,
		})),
		addons: addons.results,
		upstreamPurchases: purchases.results,
		relays: relays.results,
		periods: periods.results.map((row) => ({
			...row,
			retryAllowed: retryAllowed(row, now),
		})),
	};
}

/** "允许重新下单" only after a posting claim is at least 5 minutes old. */
export function reorderAllowed(
	row: {
		iproyal_order_state: string | null;
		iproyal_posting_at: number | null;
	},
	now: number,
) {
	return (
		(row.iproyal_order_state === "posting" ||
			row.iproyal_order_state === "unknown") &&
		(row.iproyal_posting_at ?? 0) < now - staleClaimMs
	);
}

/** "重试续期": a refused (4xx) extension any time, an unknown one only once stale. */
export function retryAllowed(
	row: { extend_status: string; extending_at: number | null },
	now: number,
) {
	return (
		row.extend_status === "failed" ||
		(row.extend_status === "extending" &&
			(row.extending_at ?? 0) < now - staleClaimMs)
	);
}

// ---------- flag ----------

export async function setClaudeEnvEnabled(
	db: D1Database,
	actor: AdminActor,
	enabled: boolean,
	now: number,
) {
	const statements = [
		db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, updated_by, created_at, updated_at)
				 VALUES (?, ?, 0, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value,
				 updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
			)
			.bind(
				claudeEnvSettingKeys.enabled,
				JSON.stringify(enabled),
				actor.userId,
				now,
				now,
			),
		// Every switch-on starts a fresh window: orders paid while the flag
		// was off stay on the manual flow and are never backfilled.
		...(enabled
			? [
					db
						.prepare(
							`INSERT INTO system_settings (key, value, is_secret, updated_by, created_at, updated_at)
							 VALUES (?, ?, 0, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value,
							 updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
						)
						.bind(
							claudeEnvSettingKeys.ingestAfter,
							JSON.stringify(now),
							actor.userId,
							now,
							now,
						),
				]
			: []),
		audit(db, actor, "claude_env.enabled_changed", "flag", { enabled }, now),
	];
	await db.batch(statements);
	return { enabled };
}

// ---------- relays ----------

export const relayInputSchema = z.object({
	id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
	hostname: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
	/** 32 random bytes as 64 hex chars (`openssl rand -hex 32`). Omit to keep the stored one. */
	secret: z
		.string()
		.trim()
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
	status: z.enum(["active", "disabled"]).default("active"),
	maxCustomers: z.number().int().min(0).max(1000).default(defaultMaxCustomers),
	monthlyQuotaBytes: z
		.number()
		.int()
		.min(0)
		.max(1e15)
		.default(defaultMonthlyQuotaBytes),
});

export async function saveRelay(
	db: D1Database,
	crypt: Crypt,
	actor: AdminActor,
	input: z.infer<typeof relayInputSchema>,
	now: number,
) {
	const existing = await db
		.prepare("SELECT id FROM claude_env_relays WHERE id = ?")
		.bind(input.id)
		.first();
	if (!existing && !input.secret)
		throw new DomainError(
			"claude_env_relay_secret_required",
			400,
			"Secret required",
		);
	const encrypted = input.secret
		? await crypt.encrypt(input.secret, secretPurpose.relaySecret)
		: null;
	await db.batch([
		existing
			? db
					.prepare(
						`UPDATE claude_env_relays SET hostname = ?, secret_encrypted = COALESCE(?, secret_encrypted), status = ?,
						 max_customers = ?, monthly_quota_bytes = ?, updated_at = ? WHERE id = ?`,
					)
					.bind(
						input.hostname,
						encrypted,
						input.status,
						input.maxCustomers,
						input.monthlyQuotaBytes,
						now,
						input.id,
					)
			: db
					.prepare(
						`INSERT INTO claude_env_relays (id, hostname, secret_encrypted, status, max_customers, monthly_quota_bytes, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						input.id,
						input.hostname,
						encrypted,
						input.status,
						input.maxCustomers,
						input.monthlyQuotaBytes,
						now,
						now,
					),
		audit(
			db,
			actor,
			existing ? "claude_env.relay_updated" : "claude_env.relay_created",
			input.id,
			{
				hostname: input.hostname,
				status: input.status,
				maxCustomers: input.maxCustomers,
				monthlyQuotaBytes: input.monthlyQuotaBytes,
				secretChanged: Boolean(input.secret),
			},
			now,
		),
	]);
	return { id: input.id };
}

// ---------- subscription actions ----------

const ipv4 = z
	.string()
	.trim()
	.regex(/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/);
const visible = z
	.string()
	.trim()
	.regex(/^[\x21-\x7e]{1,128}$/);

export const subscriptionActionSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("suspend"), id: z.string() }),
	z.object({ action: z.literal("resume"), id: z.string() }),
	z.object({
		action: z.literal("extend_days"),
		id: z.string(),
		days: z.number().int().min(1).max(366),
	}),
	z.object({
		action: z.literal("replace_ip"),
		id: z.string(),
		ip: ipv4,
		port: z.number().int().min(1).max(65535),
		user: visible,
		pass: visible,
		city: z.string().trim().max(100).optional(),
		/** The new IPRoyal order behind the swapped IP… */
		iproyalOrderId: z
			.string()
			.trim()
			.regex(/^\d{1,20}$/)
			.optional(),
		/** …or an explicit "IPRoyal swapped the IP inside the same order". */
		sameOrder: z.boolean().optional(),
	}),
	z.object({
		action: z.literal("set_iproyal_order"),
		id: z.string(),
		iproyalOrderId: z
			.string()
			.trim()
			.regex(/^\d{1,20}$/),
	}),
	z.object({ action: z.literal("allow_reorder"), id: z.string() }),
	z.object({ action: z.literal("period_done"), orderItemId: z.string() }),
	z.object({ action: z.literal("period_retry"), orderItemId: z.string() }),
]);
export type SubscriptionAction = z.infer<typeof subscriptionActionSchema>;

type SubRow = {
	id: string;
	status: string;
	status_before_suspend: string | null;
	activated_at: number | null;
	expires_at: number | null;
	iproyal_order_state: string | null;
	iproyal_order_id: string | null;
	iproyal_posting_at: number | null;
	order_item_id: string;
	ip_city: string | null;
	iproyal_location: string | null;
};

function conflict(message: string): never {
	throw new DomainError("claude_env_action_invalid", 409, message);
}

/** No grace and no revival: the IP left with the IPRoyal order when it expired. */
const expiredReleased = "IP 已随 IPRoyal 订单到期释放，不能恢复";

const pastExpiry = (
	sub: { activated_at: number | null; expires_at: number | null },
	now: number,
) =>
	sub.activated_at !== null && sub.expires_at !== null && sub.expires_at <= now;

export async function applySubscriptionAction(
	deps: { db: D1Database; crypt: Crypt; fetcher?: typeof fetch },
	actor: AdminActor,
	input: SubscriptionAction,
	now: number,
) {
	const { db } = deps;
	if (input.action === "period_done" || input.action === "period_retry") {
		const period = await db
			.prepare(
				`SELECT p.order_item_id, p.subscription_id, p.extend_status, p.extending_at, p.days,
				 s.iproyal_order_id, s.expires_at, s.status FROM claude_env_periods p
				 LEFT JOIN claude_env_subscriptions s ON s.id = p.subscription_id WHERE p.order_item_id = ?`,
			)
			.bind(input.orderItemId)
			.first<{
				order_item_id: string;
				subscription_id: string | null;
				extend_status: string;
				extending_at: number | null;
				days: number;
				iproyal_order_id: string | null;
				expires_at: number | null;
				status: string | null;
			}>();
		if (!period || !["failed", "extending"].includes(period.extend_status))
			conflict("该续期记录不需要处理");
		if (period.status === "expired") conflict(expiredReleased);
		if (input.action === "period_retry" && !retryAllowed(period, now))
			conflict(
				"续期结果还不明（不到 5 分钟）。先核对 IPRoyal 这张订单的到期时间有没有延长，再决定。",
			);
		const statements: D1PreparedStatement[] = [
			db
				.prepare(
					`UPDATE claude_env_periods SET extend_status = ?, note = ?, extending_at = NULL, updated_at = ?
					 WHERE order_item_id = ? AND extend_status = ?`,
				)
				.bind(
					input.action === "period_done" ? "done" : "pending",
					input.action === "period_done" ? "已在 IPRoyal 后台手动续期" : null,
					now,
					input.orderItemId,
					period.extend_status,
				),
		];
		if (input.action === "period_done" && period.subscription_id)
			statements.push(
				period.iproyal_order_id
					? // Re-read IPRoyal's expire_date on the next tick.
						db
							.prepare(
								"UPDATE claude_env_subscriptions SET expire_sync_needed = 1, expire_checked_at = NULL, updated_at = ? WHERE id = ?",
							)
							.bind(now, period.subscription_id)
					: db
							.prepare(
								"UPDATE claude_env_subscriptions SET expires_at = ?, updated_at = ? WHERE id = ? AND status <> 'expired'",
							)
							.bind(
								extendExpiry(period.expires_at, now, period.days),
								now,
								period.subscription_id,
							),
			);
		statements.push(
			audit(
				db,
				actor,
				`claude_env.${input.action}`,
				input.orderItemId,
				{},
				now,
			),
		);
		await db.batch(statements);
		return { ok: true };
	}
	const sub = await db
		.prepare(
			`SELECT id, status, status_before_suspend, activated_at, expires_at, iproyal_order_state, iproyal_order_id,
			 iproyal_posting_at, order_item_id, ip_city, iproyal_location FROM claude_env_subscriptions WHERE id = ?`,
		)
		.bind(input.id)
		.first<SubRow>();
	if (!sub) throw new DomainError("claude_env_not_found", 404, "Not found");
	const statements: D1PreparedStatement[] = [];
	let detail: Record<string, unknown> = {};
	switch (input.action) {
		case "suspend": {
			if (
				!["awaiting_ip", "provisioning", "active", "needs_replace"].includes(
					sub.status,
				)
			)
				conflict("当前状态不能暂停");
			statements.push(
				db
					.prepare(
						"UPDATE claude_env_subscriptions SET status_before_suspend = status, status = 'suspended', updated_at = ? WHERE id = ?",
					)
					.bind(now, sub.id),
			);
			break;
		}
		case "resume": {
			if (sub.status === "expired" || pastExpiry(sub, now))
				conflict(expiredReleased);
			if (sub.status !== "suspended") conflict("只有已暂停的才能恢复");
			const back =
				sub.status_before_suspend ??
				(sub.activated_at ? "active" : "awaiting_ip");
			statements.push(
				db
					.prepare(
						"UPDATE claude_env_subscriptions SET status = ?, status_before_suspend = NULL, updated_at = ? WHERE id = ?",
					)
					.bind(back, now, sub.id),
			);
			detail = { status: back };
			break;
		}
		case "extend_days": {
			if (["cancelled"].includes(sub.status)) conflict("已取消的不能延长");
			if (sub.status === "expired" || pastExpiry(sub, now))
				conflict(expiredReleased);
			if (sub.activated_at !== null) {
				const expiresAt = extendExpiry(sub.expires_at, now, input.days);
				statements.push(
					db
						.prepare(
							"UPDATE claude_env_subscriptions SET expires_at = ?, updated_at = ? WHERE id = ? AND status <> 'expired'",
						)
						.bind(expiresAt, now, sub.id),
				);
				detail = { days: input.days, expiresAt };
			} else {
				statements.push(
					db
						.prepare(
							"UPDATE claude_env_subscriptions SET pending_days = pending_days + ?, updated_at = ? WHERE id = ?",
						)
						.bind(input.days, now, sub.id),
				);
				detail = { days: input.days, pending: true };
			}
			break;
		}
		case "replace_ip": {
			if (
				!["needs_replace", "provisioning", "awaiting_ip"].includes(sub.status)
			)
				conflict("只有待换 IP / 开通中的订阅可以换 IP（已交付的 IP 不换）");
			if (!input.iproyalOrderId && !input.sameOrder)
				conflict("请填新的 IPRoyal 订单号，或勾选「还是原来那张订单」");
			if (input.sameOrder && !input.iproyalOrderId && !sub.iproyal_order_id)
				conflict("原订阅没有 IPRoyal 订单号，请填新的订单号");
			const orderId = input.iproyalOrderId ?? sub.iproyal_order_id;
			const city = input.city || sub.ip_city || sub.iproyal_location;
			const tz = canonicalTimezone(
				(await lookupTimezone(input.ip, deps.fetcher ?? fetch)) ??
					timezoneForCity(city),
			);
			statements.push(
				db
					.prepare(
						`UPDATE claude_env_subscriptions SET status = 'provisioning', ip = ?, ip_port = ?, ip_city = ?, ip_tz = ?,
						 ip_user_encrypted = ?, ip_pass_encrypted = ?,
						 iproyal_order_id = ?, iproyal_order_state = 'ordered', expire_sync_needed = 1, expire_checked_at = NULL,
						 relay_check_ok = 0, relay_check_fail_streak = 0, apply_fail_streak = 0, relay_scam_score = NULL, needs_replace_reason = NULL,
						 qc_trust_score = NULL, qc_scam_score = NULL, qc_note = NULL, qc_at = NULL, attempt_after = 0, updated_at = ?
						 WHERE id = ?`,
					)
					.bind(
						input.ip,
						input.port,
						city ?? null,
						tz,
						await deps.crypt.encrypt(input.user, secretPurpose.upstreamUser),
						await deps.crypt.encrypt(input.pass, secretPurpose.upstreamPass),
						orderId,
						now,
						sub.id,
					),
			);
			if (orderId)
				statements.push(
					db
						.prepare(
							"UPDATE claude_env_periods SET units_extended = MAX(units_extended, 1), extend_status = CASE WHEN units > 1 AND extend_status = 'none' THEN 'pending' WHEN extend_status = 'none' THEN 'done' ELSE extend_status END, updated_at = ? WHERE order_item_id = ? AND kind = 'initial'",
						)
						.bind(now, sub.order_item_id),
				);
			detail = {
				ip: input.ip,
				city,
				tz,
				iproyalOrderId: orderId,
				sameOrder: !input.iproyalOrderId,
			};
			break;
		}
		case "set_iproyal_order": {
			if (
				sub.status !== "awaiting_ip" ||
				!["posting", "unknown"].includes(sub.iproyal_order_state ?? "")
			)
				conflict("只有「下单结果不明」的订阅需要填订单号");
			statements.push(
				db
					.prepare(
						"UPDATE claude_env_subscriptions SET iproyal_order_id = ?, iproyal_order_state = 'ordered', attempt_after = 0, last_error = NULL, updated_at = ? WHERE id = ?",
					)
					.bind(input.iproyalOrderId, now, sub.id),
				db
					.prepare(
						"UPDATE claude_env_periods SET units_extended = MAX(units_extended, 1), extend_status = CASE WHEN units > 1 THEN 'pending' ELSE 'done' END, updated_at = ? WHERE order_item_id = ? AND kind = 'initial'",
					)
					.bind(now, sub.order_item_id),
			);
			detail = { iproyalOrderId: input.iproyalOrderId };
			break;
		}
		case "allow_reorder": {
			if (
				sub.status !== "awaiting_ip" ||
				!["posting", "unknown"].includes(sub.iproyal_order_state ?? "")
			)
				conflict("只有「下单结果不明」的订阅可以重新下单");
			if (!reorderAllowed(sub, now))
				conflict(
					"下单才过去不到 5 分钟。先去 IPRoyal 后台核对有没有这一单，确认没有再点。",
				);
			statements.push(
				db
					.prepare(
						"UPDATE claude_env_subscriptions SET iproyal_order_state = NULL, iproyal_posting_at = NULL, order_unknown_alerted = 0, attempt_after = 0, last_error = NULL, updated_at = ? WHERE id = ?",
					)
					.bind(now, sub.id),
			);
			break;
		}
	}
	statements.push(
		eventStatement(
			db,
			sub.id,
			`admin_${input.action}`,
			JSON.stringify(detail),
			now,
		),
		audit(db, actor, `claude_env.${input.action}`, sub.id, detail, now),
	);
	await db.batch(statements);
	return { ok: true };
}
