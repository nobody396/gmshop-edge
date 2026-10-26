import {
	type ClaudeEnvStatus,
	claudeEnvProductId,
	claudeEnvSettingKeys,
	claudeEnvSkuIds,
	customerCommands,
	daysLeft,
	displayCity,
	encodeActivationCode,
	renewalPath,
	trafficPeriodMs,
} from "../domain";
import { type Crypt, secretPurpose } from "./shared";

type PanelRow = {
	id: string;
	status: ClaudeEnvStatus;
	plan: string;
	ip: string | null;
	ip_city: string | null;
	ip_tz: string | null;
	activated_at: number | null;
	expires_at: number | null;
	traffic_period_start: number | null;
	traffic_period_bytes: number;
	traffic_quota_bytes: number;
	last_check_at: number | null;
	last_exit_ok: number | null;
	relay_port: number | null;
	relay_user: string | null;
	relay_pass_encrypted: string | null;
	hostname: string | null;
};

/**
 * The subscription behind one order, but only when the logged-in user owns
 * both the order and the subscription. Never keyed by anything the client
 * controls except the order number.
 */
async function ownedSubscription(
	db: D1Database,
	userId: string,
	orderNumber: string,
) {
	return db
		.prepare(
			`SELECT s.id, s.status, s.plan, s.ip, s.ip_city, s.ip_tz, s.activated_at, s.expires_at,
			 s.traffic_period_start, s.traffic_period_bytes, s.traffic_quota_bytes, s.last_check_at, s.last_exit_ok,
			 s.relay_port, s.relay_user, s.relay_pass_encrypted, r.hostname
			 FROM shop_orders o
			 JOIN claude_env_periods p ON p.order_id = o.id
			 JOIN claude_env_subscriptions s ON s.id = p.subscription_id
			 LEFT JOIN claude_env_relays r ON r.id = s.relay_id
			 WHERE o.order_number = ? AND o.user_id = ? AND s.user_id = ?
			 ORDER BY s.created_at DESC LIMIT 1`,
		)
		.bind(orderNumber, userId, userId)
		.first<PanelRow>();
}

async function orderHasClaudeEnvItem(
	db: D1Database,
	userId: string,
	orderNumber: string,
) {
	const row = await db
		.prepare(
			`SELECT o.status FROM shop_orders o JOIN shop_order_items oi ON oi.order_id = o.id
			 WHERE o.order_number = ? AND o.user_id = ? AND (oi.product_id = ? OR oi.sellable_item_id IN (${claudeEnvSkuIds.map(() => "?").join(",")}))
			 LIMIT 1`,
		)
		.bind(orderNumber, userId, claudeEnvProductId, ...claudeEnvSkuIds)
		.first<{ status: string }>();
	return row;
}

async function automationEnabled(db: D1Database) {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key = ?")
		.bind(claudeEnvSettingKeys.enabled)
		.first<{ value: string }>();
	return row?.value === "true";
}

export type ClaudeEnvPanel = Awaited<ReturnType<typeof loadClaudeEnvPanel>>;

export async function loadClaudeEnvPanel(
	db: D1Database,
	userId: string,
	orderNumber: string,
	now: number,
) {
	const row = await ownedSubscription(db, userId, orderNumber);
	if (!row) {
		const order = await orderHasClaudeEnvItem(db, userId, orderNumber);
		if (!order || !(await automationEnabled(db))) return null;
		if (!["paid", "fulfilling", "completed"].includes(order.status))
			return null;
		return { state: "preparing" as const };
	}
	// Expired: the IP went back with the upstream order and can never return.
	const expired = row.status === "expired";
	const left = row.expires_at === null ? null : daysLeft(row.expires_at, now);
	const periodCurrent =
		row.traffic_period_start !== null &&
		now < row.traffic_period_start + trafficPeriodMs;
	return {
		state: "subscription" as const,
		status: row.status,
		plan: row.plan,
		ip: expired ? null : row.ip,
		city: expired ? null : displayCity(row.ip_city),
		timezone: expired ? null : row.ip_tz,
		activatedAt: row.activated_at,
		expiresAt: row.expires_at,
		daysLeft: left,
		/** Active and within 7 days of expiry: the panel shows the renewal banner. */
		expiringSoon:
			row.status === "active" &&
			row.expires_at !== null &&
			row.expires_at > now &&
			left !== null &&
			left <= 7,
		renewUrl: renewalPath(row.plan),
		trafficUsedBytes: periodCurrent ? row.traffic_period_bytes : 0,
		trafficQuotaBytes: row.traffic_quota_bytes,
		trafficResetAt:
			row.traffic_period_start === null
				? null
				: periodCurrent
					? row.traffic_period_start + trafficPeriodMs
					: null,
		lastCheckAt: row.last_check_at,
		lineOk: row.last_exit_ok === null ? null : row.last_exit_ok === 1,
		codeAvailable: row.status === "active",
		ipCheckUrl: customerCommands("").ipCheck,
	};
}

/** Activation code + one-line commands; only for an active subscription the user owns. */
export async function revealClaudeEnvCode(
	db: D1Database,
	crypt: Crypt,
	userId: string,
	orderNumber: string,
) {
	const row = await ownedSubscription(db, userId, orderNumber);
	if (
		!row ||
		row.status !== "active" ||
		!row.hostname ||
		!row.relay_port ||
		!row.relay_user ||
		!row.relay_pass_encrypted ||
		!row.ip ||
		!row.ip_tz
	)
		return null;
	const code = encodeActivationCode({
		host: row.hostname,
		port: row.relay_port,
		user: row.relay_user,
		pass: await crypt.decrypt(
			row.relay_pass_encrypted,
			secretPurpose.relayPass,
		),
		ip: row.ip,
		tz: row.ip_tz,
	});
	return { code, ...customerCommands(code) };
}
