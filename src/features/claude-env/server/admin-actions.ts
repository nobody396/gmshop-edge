import { z } from "zod";
import { DomainError } from "#/lib/domain-error";
import {
	claudeEnvSettingKeys,
	defaultMaxCustomers,
	defaultMonthlyQuotaBytes,
	desiredStatuses,
	extendExpiry,
	maskEmail,
	relaySlotStatuses,
	timezoneForCity,
} from "../domain";
import {
	type Crypt,
	eventStatement,
	lookupTimezone,
	secretPurpose,
} from "./shared";

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
	note: Nullable<string>;
	created_at: number;
	order_number: Nullable<string>;
};

// ---------- overview ----------

export async function loadClaudeEnvAdmin(db: D1Database, now: number) {
	const [flag, subs, relays, periods] = await Promise.all([
		db
			.prepare("SELECT value FROM system_settings WHERE key = ?")
			.bind(claudeEnvSettingKeys.enabled)
			.first<{ value: string }>(),
		db
			.prepare(
				`SELECT s.id, s.email, s.status, s.plan, s.ip, s.ip_city, s.ip_tz, s.relay_id, s.relay_port,
				 s.iproyal_order_id, s.iproyal_order_state, s.expires_at, s.pending_days, s.activated_at,
				 s.traffic_period_bytes, s.traffic_period_start, s.traffic_total_bytes, s.traffic_quota_bytes,
				 s.last_check_at, s.last_exit_ok, s.last_anthropic_status, s.last_apply_error, s.last_error,
				 s.qc_trust_score, s.qc_scam_score, s.qc_note, s.needs_replace_reason, s.created_at, o.order_number
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
				 p.note, p.created_at, o.order_number FROM claude_env_periods p LEFT JOIN shop_orders o ON o.id = p.order_id
				 WHERE p.extend_status IN ('failed','extending') OR p.kind = 'skipped'
				 ORDER BY p.created_at DESC LIMIT 100`,
			)
			.all<AdminPeriodRow>(),
	]);
	return {
		now,
		enabled: flag?.value === "true",
		subscriptions: subs.results.map((row) => ({
			...row,
			email: maskEmail(row.email),
		})),
		relays: relays.results,
		periods: periods.results,
	};
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
		iproyalOrderId: z
			.string()
			.trim()
			.regex(/^\d{1,20}$/)
			.optional(),
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
	order_item_id: string;
	ip_city: string | null;
	iproyal_location: string | null;
};

function conflict(message: string): never {
	throw new DomainError("claude_env_action_invalid", 409, message);
}

export async function applySubscriptionAction(
	deps: { db: D1Database; crypt: Crypt; fetcher?: typeof fetch },
	actor: AdminActor,
	input: SubscriptionAction,
	now: number,
) {
	const { db } = deps;
	if (input.action === "period_done" || input.action === "period_retry") {
		const result = await db
			.prepare(
				`UPDATE claude_env_periods SET extend_status = ?, note = ?, updated_at = ?
				 WHERE order_item_id = ? AND extend_status IN ('failed','extending')`,
			)
			.bind(
				input.action === "period_done" ? "done" : "pending",
				input.action === "period_done" ? "已在 IPRoyal 后台手动续期" : null,
				now,
				input.orderItemId,
			)
			.run();
		if (Number(result.meta.changes ?? 0) !== 1)
			conflict("该续期记录不需要处理");
		await audit(
			db,
			actor,
			`claude_env.${input.action}`,
			input.orderItemId,
			{},
			now,
		).run();
		return { ok: true };
	}
	const sub = await db
		.prepare(
			`SELECT id, status, status_before_suspend, activated_at, expires_at, iproyal_order_state, order_item_id,
			 ip_city, iproyal_location FROM claude_env_subscriptions WHERE id = ?`,
		)
		.bind(input.id)
		.first<SubRow>();
	if (!sub) throw new DomainError("claude_env_not_found", 404, "Not found");
	const statements: D1PreparedStatement[] = [];
	let detail: Record<string, unknown> = {};
	switch (input.action) {
		case "suspend": {
			if (
				![
					"awaiting_ip",
					"provisioning",
					"active",
					"grace",
					"needs_replace",
				].includes(sub.status)
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
			if (sub.activated_at !== null) {
				const expiresAt = extendExpiry(sub.expires_at, now, input.days);
				statements.push(
					db
						.prepare(
							`UPDATE claude_env_subscriptions SET expires_at = ?,
							 status = CASE WHEN status IN ('grace','expired') THEN 'active' ELSE status END, updated_at = ? WHERE id = ?`,
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
			const city = input.city || sub.ip_city || sub.iproyal_location;
			const tz =
				(await lookupTimezone(input.ip, deps.fetcher ?? fetch)) ??
				timezoneForCity(city);
			statements.push(
				db
					.prepare(
						`UPDATE claude_env_subscriptions SET status = 'provisioning', ip = ?, ip_port = ?, ip_city = ?, ip_tz = ?,
						 ip_user_encrypted = ?, ip_pass_encrypted = ?,
						 iproyal_order_id = COALESCE(?, iproyal_order_id),
						 iproyal_order_state = CASE WHEN ? IS NOT NULL OR iproyal_order_id IS NOT NULL THEN 'ordered' ELSE iproyal_order_state END,
						 relay_check_ok = 0, relay_check_fail_streak = 0, needs_replace_reason = NULL,
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
						input.iproyalOrderId ?? null,
						input.iproyalOrderId ?? null,
						now,
						sub.id,
					),
			);
			if (input.iproyalOrderId)
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
				iproyalOrderId: input.iproyalOrderId ?? null,
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
			statements.push(
				db
					.prepare(
						"UPDATE claude_env_subscriptions SET iproyal_order_state = NULL, attempt_after = 0, last_error = NULL, updated_at = ? WHERE id = ?",
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
