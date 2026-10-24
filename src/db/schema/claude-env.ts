import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth";

/** Mirrors drizzle/0046_claude_env.sql (hand-written migration). */
export const claudeEnvRelays = sqliteTable("claude_env_relays", {
	id: text("id").primaryKey(),
	hostname: text("hostname").notNull(),
	secretEncrypted: text("secret_encrypted").notNull(),
	status: text("status", { enum: ["active", "disabled"] })
		.notNull()
		.default("active"),
	maxCustomers: integer("max_customers").notNull().default(10),
	monthlyQuotaBytes: integer("monthly_quota_bytes")
		.notNull()
		.default(5_000_000_000_000),
	hostMonth: text("host_month"),
	hostRxBytes: integer("host_rx_bytes").notNull().default(0),
	hostTxBytes: integer("host_tx_bytes").notNull().default(0),
	quotaAlertMonth: text("quota_alert_month"),
	lastReportAt: integer("last_report_at"),
	offlineAlertedAt: integer("offline_alerted_at"),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const claudeEnvSubscriptions = sqliteTable(
	"claude_env_subscriptions",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		email: text("email").notNull(),
		orderId: text("order_id").notNull(),
		orderItemId: text("order_item_id").notNull(),
		plan: text("plan", {
			enum: ["monthly", "quarterly", "eb_monthly", "eb_quarterly"],
		}).notNull(),
		status: text("status", {
			enum: [
				"awaiting_ip",
				"provisioning",
				"active",
				"needs_replace",
				"grace",
				"expired",
				"suspended",
				"cancelled",
			],
		})
			.notNull()
			.default("awaiting_ip"),
		statusBeforeSuspend: text("status_before_suspend"),
		relayId: text("relay_id").references(() => claudeEnvRelays.id),
		relayPort: integer("relay_port"),
		relayUser: text("relay_user"),
		relayPassEncrypted: text("relay_pass_encrypted"),
		iproyalPlanId: integer("iproyal_plan_id").notNull(),
		iproyalOrderState: text("iproyal_order_state", {
			enum: ["posting", "ordered", "unknown"],
		}),
		iproyalOrderId: text("iproyal_order_id"),
		iproyalPostingAt: integer("iproyal_posting_at"),
		orderUnknownAlerted: integer("order_unknown_alerted").notNull().default(0),
		iproyalLocation: text("iproyal_location"),
		iproyalExpiresAt: integer("iproyal_expires_at"),
		expireSyncNeeded: integer("expire_sync_needed").notNull().default(0),
		expireCheckedAt: integer("expire_checked_at"),
		ipInvalidAlerted: integer("ip_invalid_alerted").notNull().default(0),
		ip: text("ip"),
		ipPort: integer("ip_port"),
		ipCity: text("ip_city"),
		ipTz: text("ip_tz"),
		ipUserEncrypted: text("ip_user_encrypted"),
		ipPassEncrypted: text("ip_pass_encrypted"),
		pendingDays: integer("pending_days").notNull().default(0),
		activatedAt: integer("activated_at"),
		expiresAt: integer("expires_at"),
		expiredAt: integer("expired_at"),
		trafficPeriodStart: integer("traffic_period_start"),
		trafficPeriodBytes: integer("traffic_period_bytes").notNull().default(0),
		trafficTotalBytes: integer("traffic_total_bytes").notNull().default(0),
		trafficQuotaBytes: integer("traffic_quota_bytes")
			.notNull()
			.default(200_000_000_000),
		relayCheckOk: integer("relay_check_ok").notNull().default(0),
		relayCheckFailStreak: integer("relay_check_fail_streak")
			.notNull()
			.default(0),
		applyFailStreak: integer("apply_fail_streak").notNull().default(0),
		lastCheckAt: integer("last_check_at"),
		lastExitOk: integer("last_exit_ok"),
		lastExitIp: text("last_exit_ip"),
		lastAnthropicStatus: integer("last_anthropic_status"),
		lastApplyError: text("last_apply_error"),
		exitFailStreak: integer("exit_fail_streak").notNull().default(0),
		patrolAlerted: integer("patrol_alerted").notNull().default(0),
		relayScamScore: integer("relay_scam_score"),
		qcTrustScore: real("qc_trust_score"),
		qcScamScore: integer("qc_scam_score"),
		qcNote: text("qc_note"),
		qcAt: integer("qc_at"),
		needsReplaceReason: text("needs_replace_reason"),
		refundSeen: integer("refund_seen").notNull().default(0),
		attemptAfter: integer("attempt_after").notNull().default(0),
		lastError: text("last_error"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("claude_env_subscriptions_order_item_uidx").on(
			table.orderItemId,
		),
		uniqueIndex("claude_env_subscriptions_relay_port_uidx").on(
			table.relayId,
			table.relayPort,
		),
		index("claude_env_subscriptions_status_idx").on(
			table.status,
			table.attemptAfter,
		),
		index("claude_env_subscriptions_user_idx").on(table.userId, table.status),
	],
);

export const claudeEnvPeriods = sqliteTable(
	"claude_env_periods",
	{
		orderItemId: text("order_item_id").primaryKey(),
		orderId: text("order_id").notNull(),
		subscriptionId: text("subscription_id").references(
			() => claudeEnvSubscriptions.id,
		),
		kind: text("kind", {
			enum: ["initial", "renewal", "skipped", "waiting"],
		}).notNull(),
		plan: text("plan"),
		days: integer("days").notNull().default(0),
		units: integer("units").notNull().default(0),
		iproyalPlanId: integer("iproyal_plan_id"),
		unitsExtended: integer("units_extended").notNull().default(0),
		extendStatus: text("extend_status", {
			enum: ["none", "pending", "extending", "done", "failed", "cancelled"],
		})
			.notNull()
			.default("none"),
		extendingAt: integer("extending_at"),
		staleAlerted: integer("stale_alerted").notNull().default(0),
		refundHandled: integer("refund_handled").notNull().default(0),
		remindCount: integer("remind_count").notNull().default(0),
		nextRemindAt: integer("next_remind_at"),
		note: text("note"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		index("claude_env_periods_extend_idx").on(
			table.extendStatus,
			table.subscriptionId,
		),
		index("claude_env_periods_kind_idx").on(table.kind, table.orderId),
	],
);

export const claudeEnvReports = sqliteTable(
	"claude_env_reports",
	{
		reportId: text("report_id").primaryKey(),
		relayId: text("relay_id").notNull(),
		receivedAt: integer("received_at").notNull(),
	},
	(table) => [index("claude_env_reports_received_idx").on(table.receivedAt)],
);

export const claudeEnvEvents = sqliteTable(
	"claude_env_events",
	{
		id: text("id").primaryKey(),
		subscriptionId: text("subscription_id"),
		kind: text("kind").notNull(),
		detail: text("detail"),
		createdAt: integer("created_at").notNull(),
	},
	(table) => [
		index("claude_env_events_subscription_idx").on(
			table.subscriptionId,
			table.createdAt,
		),
	],
);
