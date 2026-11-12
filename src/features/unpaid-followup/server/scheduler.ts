import { agentAccessProducts } from "#/features/agent-access/products";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { gptUpgradeProduct } from "#/features/gpt-upgrade/products";
import {
	enqueueEmailNotification,
	supportReplyEmailSender,
	unpaidFollowupEmailEvent,
} from "#/features/notifications/server/delivery";
import {
	isReservedEmailRecipient,
	recipientHash,
	recipientSuppressionReason,
} from "#/features/notifications/server/recipient-policy";
import { isEmailAddress } from "#/features/renewals/domain";
import {
	renewalOrigin,
	renewalUnsubscribeUrl,
} from "#/features/renewals/server/links";
import {
	loadBrand,
	meteredD1,
	staffOrderCondition,
} from "#/features/renewals/server/scheduler";
import { checkoutChannelLimits } from "#/features/shop-payments/server/split";
import { paymentLimitDecision } from "#/features/shop-payments/split";
import type { SupportedLocale } from "#/lib/locales";
import { loadRuntimeConfig, type RuntimeConfig } from "#/server/runtime-config";
import {
	renderUnpaidFollowupEmail,
	unpaidFollowupReorderUrl,
	unpaidFollowupSupportUrl,
} from "./email";
import { loadUnpaidFollowupSettings } from "./settings";

const minuteMs = 60_000;
const dayMs = 86_400_000;
/** The email goes out 30–60 minutes after the order expired unpaid. */
export const unpaidFollowupDelayMs = 30 * minuteMs;
export const unpaidFollowupWindowEndMs = 60 * minuteMs;
/** One follow-up per recipient per 30 days. */
export const unpaidFollowupRecipientCooldownMs = 30 * dayMs;
/** A claimed send that never finished is marked failed, never resent. */
const sendingTimeoutMs = 15 * minuteMs;
/** D1 calls one pass may make (shared per-minute cron). */
export const unpaidFollowupD1Budget = 150;
/** Worst-case D1 calls for one candidate (assessment, claim, enqueue, update). */
const candidateCost = 20;

/** Price-difference top-up utility checkout (not a product to follow up). */
export const priceDifferenceProductId = "643ba58d-3441-4ac5-b2e4-4a4007f24cc0";
const agentAccessProductIds: ReadonlySet<string> = new Set(
	Object.values(agentAccessProducts).map((product) => product.productId),
);
const upgradeProductIds: ReadonlySet<string> = new Set([
	gptUpgradeProduct.productId,
	priceDifferenceProductId,
]);
const alipayProviders: ReadonlySet<string> = new Set([
	"epay",
	"alipay_page",
	"alipay_wap",
	"alipay_qr",
]);
const usdtProviders: ReadonlySet<string> = new Set(["gmpay", "cryptomus"]);

export type UnpaidFollowupSkipReason =
	| "not_expired"
	| "paid"
	| "no_items"
	| "agent_api_order"
	| "agent_access_order"
	| "upgrade_order"
	| "test_item"
	| "no_email"
	| "test_email"
	| "staff"
	| "agent"
	| "paid_later"
	| "existing_customer"
	| "unsubscribed"
	| "suppressed"
	| "recent_followup"
	| "item_unavailable";

type OrderRow = {
	id: string;
	order_number: string;
	user_id: string | null;
	email: string | null;
	locale: string;
	status: string;
	created_at: number;
	expires_at: number;
	paid_at: number | null;
	paid_minor: string;
	pricing_channel_id: string | null;
	any_payment: number;
	agent_api_order: number;
	staff: number;
	agent: number;
};

type ItemRow = {
	id: string;
	product_id: string;
	sellable_item_id: string;
	product_name: string;
	sellable_item_name: string;
	quantity: number;
	unit_price_minor: string;
	agent_access: number;
	upgrade: number;
	sellable: number;
};

const orderColumns = `o.id, o.order_number, o.user_id,
 o.normalized_contact_email AS email, o.locale, o.status, o.created_at,
 o.expires_at, o.paid_at, o.paid_minor, o.pricing_channel_id,
 (EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.order_id = o.id AND pa.status = 'succeeded')
  OR EXISTS (SELECT 1 FROM payment_split_parts sp JOIN payment_attempts pa ON pa.id = sp.payment_attempt_id
   WHERE pa.order_id = o.id AND sp.status = 'succeeded')) AS any_payment,
 EXISTS (SELECT 1 FROM supplier_api_orders sa WHERE sa.shop_order_id = o.id) AS agent_api_order,
 ${staffOrderCondition("o.user_id", "o.normalized_contact_email")} AS staff,
 (EXISTS (SELECT 1 FROM agent_access_orders aa WHERE aa.user_id = o.user_id
   OR lower(trim(aa.email)) = o.normalized_contact_email)
  OR EXISTS (SELECT 1 FROM supplier_api_keys k WHERE k.user_id = o.user_id)
  OR EXISTS (SELECT 1 FROM supplier_api_allowed_users au WHERE au.user_id = o.user_id)
  OR EXISTS (SELECT 1 FROM users au JOIN supplier_api_keys k ON k.user_id = au.id
   WHERE o.normalized_contact_email IS NOT NULL AND lower(au.email) = o.normalized_contact_email)
 ) AS agent`;

export type UnpaidFollowupAssessment = {
	orderId: string;
	orderNumber: string;
	email: string | null;
	locale: SupportedLocale;
	createdAt: number;
	expiresAt: number;
	status: string;
	eligible: boolean;
	reason: UnpaidFollowupSkipReason | null;
	item: {
		productId: string;
		sellableItemId: string;
		name: string;
	} | null;
	usdtHint: boolean;
};

export function followupLocale(locale: string | null): SupportedLocale {
	return locale === "en-US" ? "en-US" : "zh-CN";
}

function itemName(row: { sellable_item_name: string; product_name: string }) {
	const name = row.sellable_item_name.trim();
	return (name && name !== "Default" ? name : row.product_name).slice(0, 120);
}

function itemLabel(items: ItemRow[], locale: SupportedLocale) {
	const names = [...new Set(items.map(itemName))];
	const shown = names.slice(0, 3).join(locale === "zh-CN" ? "、" : ", ");
	return names.length > 3 ? `${shown}…` : shown;
}

export async function loadFollowupOrder(
	db: D1Database,
	where: { id: string } | { orderNumber: string },
) {
	return db
		.prepare(
			`SELECT ${orderColumns} FROM shop_orders o WHERE ${
				"id" in where ? "o.id = ?" : "o.order_number = ?"
			} LIMIT 1`,
		)
		.bind("id" in where ? where.id : where.orderNumber)
		.first<OrderRow>();
}

/**
 * Applies every content rule to one order (timing and the activation cutoff
 * are the caller's job). Read-only: never writes, enqueues or sends.
 */
export async function assessUnpaidOrder(
	db: D1Database,
	order: OrderRow,
	now: number,
): Promise<UnpaidFollowupAssessment> {
	const locale = followupLocale(order.locale);
	const email = order.email?.trim().toLowerCase() || null;
	const base = {
		orderId: order.id,
		orderNumber: order.order_number,
		email,
		locale,
		createdAt: order.created_at,
		expiresAt: order.expires_at,
		status: order.status,
	};
	const items = await db
		.prepare(
			`SELECT i.id, i.product_id, i.sellable_item_id, i.product_name,
			 i.sellable_item_name, i.quantity, i.unit_price_minor,
			 EXISTS (SELECT 1 FROM agent_access_orders aa WHERE aa.order_item_id = i.id) AS agent_access,
			 EXISTS (SELECT 1 FROM gpt_upgrade_orders u WHERE u.order_item_id = i.id) AS upgrade,
			 (p.status = 'active' AND p.sale_disabled = 0 AND s.enabled = 1
			  AND s.sale_disabled = 0) AS sellable
			 FROM shop_order_items i
			 LEFT JOIN products p ON p.id = i.product_id
			 LEFT JOIN product_sellable_items s ON s.id = i.sellable_item_id
			 WHERE i.order_id = ? ORDER BY i.created_at, i.id`,
		)
		.bind(order.id)
		.all<ItemRow>();
	const first = items.results[0];
	const item = first
		? {
				productId: first.product_id,
				sellableItemId: first.sellable_item_id,
				name: itemLabel(items.results, locale),
			}
		: null;
	const skip = (reason: UnpaidFollowupSkipReason) => ({
		...base,
		eligible: false,
		reason,
		item,
		usdtHint: false,
	});
	if (order.status !== "expired") return skip("not_expired");
	if (order.paid_at !== null || order.paid_minor !== "0" || order.any_payment)
		return skip("paid");
	if (!first) return skip("no_items");
	if (order.agent_api_order) return skip("agent_api_order");
	if (
		items.results.some(
			(row) => row.agent_access || agentAccessProductIds.has(row.product_id),
		)
	)
		return skip("agent_access_order");
	if (
		items.results.some(
			(row) =>
				row.upgrade ||
				upgradeProductIds.has(row.product_id) ||
				`${row.product_name} ${row.sellable_item_name}`.includes("补差价"),
		)
	)
		return skip("upgrade_order");
	if (
		items.results.some((row) =>
			`${row.product_name} ${row.sellable_item_name}`.includes("测试"),
		)
	)
		return skip("test_item");
	if (!email || !isEmailAddress(email)) return skip("no_email");
	if (isInternalIdentityEmail(email) || isReservedEmailRecipient(email))
		return skip("test_email");
	if (order.staff) return skip("staff");
	if (order.agent) return skip("agent");
	const history = await db
		.prepare(
			`SELECT MAX(paid_at >= ?) AS paid_later, MAX(paid_at < ?) AS paid_before FROM (
			 SELECT paid_at FROM shop_orders WHERE normalized_contact_email = ?
			  AND id <> ? AND paid_at IS NOT NULL
			 UNION ALL
			 SELECT paid_at FROM shop_orders WHERE ? IS NOT NULL AND user_id = ?
			  AND id <> ? AND paid_at IS NOT NULL)`,
		)
		.bind(
			order.created_at,
			order.created_at,
			email,
			order.id,
			order.user_id,
			order.user_id,
			order.id,
		)
		.first<{ paid_later: number | null; paid_before: number | null }>();
	if (history?.paid_later) return skip("paid_later");
	if (history?.paid_before) return skip("existing_customer");
	const hash = await recipientHash(email);
	const unsubscribed = await db
		.prepare(
			"SELECT 1 AS found FROM email_unsubscribes WHERE recipient_hash = ? LIMIT 1",
		)
		.bind(hash)
		.first<{ found: number }>();
	if (unsubscribed) return skip("unsubscribed");
	if (await recipientSuppressionReason(db, email, unpaidFollowupEmailEvent))
		return skip("suppressed");
	const recent = await db
		.prepare(
			`SELECT 1 AS found FROM unpaid_order_followups
			 WHERE recipient_hash = ? AND order_id <> ? AND status IN ('sending','sent')
			 AND COALESCE(sent_at, created_at) >= ? LIMIT 1`,
		)
		.bind(hash, order.id, now - unpaidFollowupRecipientCooldownMs)
		.first<{ found: number }>();
	if (recent) return skip("recent_followup");
	if (!first.sellable) return skip("item_unavailable");
	return {
		...base,
		eligible: true,
		reason: null,
		item,
		usdtHint: await usdtToAlipayHint(db, order, items.results, now),
	};
}

/**
 * True only when every payment channel the customer used for this order (its
 * payment attempts; the channel it was priced for when none was created) is a
 * USDT channel, and an Alipay channel can take this order right now.
 */
export async function usdtToAlipayHint(
	db: D1Database,
	order: Pick<OrderRow, "id" | "pricing_channel_id">,
	items: Array<
		Pick<ItemRow, "sellable_item_id" | "quantity" | "unit_price_minor">
	>,
	now: number,
) {
	const attempted = await db
		.prepare(
			`SELECT DISTINCT pc.provider, pc.default_token, pa.currency
			 FROM payment_attempts pa JOIN payment_channels pc ON pc.id = pa.channel_id
			 WHERE pa.order_id = ?`,
		)
		.bind(order.id)
		.all<{ provider: string; default_token: string; currency: string }>();
	let used = attempted.results;
	if (!used.length && order.pricing_channel_id) {
		const priced = await db
			.prepare(
				`SELECT provider, default_token, currency FROM payment_channels
				 WHERE id = ? LIMIT 1`,
			)
			.bind(order.pricing_channel_id)
			.first<{ provider: string; default_token: string; currency: string }>();
		used = priced ? [priced] : [];
	}
	const isUsdt = (channel: (typeof used)[number]) =>
		usdtProviders.has(channel.provider) ||
		channel.currency.toUpperCase() === "USDT" ||
		channel.default_token.toUpperCase().startsWith("USDT");
	if (
		!used.length ||
		used.some((channel) => alipayProviders.has(channel.provider)) ||
		!used.every(isUsdt)
	)
		return false;
	const channels = await db
		.prepare(
			`SELECT id, provider, split_enabled, per_payment_max_minor,
			 daily_max_minor, split_max_parts FROM payment_channels
			 WHERE enabled = 1 AND provider IN ('epay','alipay_page','alipay_wap','alipay_qr')
			 ORDER BY sort_order, id`,
		)
		.all<{
			id: string;
			provider: string;
			split_enabled: number;
			per_payment_max_minor: string;
			daily_max_minor: string;
			split_max_parts: number;
		}>();
	if (!channels.results.length) return false;
	const limits = await checkoutChannelLimits(db, channels.results, now);
	for (const channel of channels.results) {
		const channelLimits = limits.get(channel.id);
		if (!channelLimits) return true;
		const prices = await db
			.prepare(
				`SELECT sellable_item_id, price_minor FROM sellable_item_channel_prices
				 WHERE channel_id = ? AND enabled = 1`,
			)
			.bind(channel.id)
			.all<{ sellable_item_id: string; price_minor: string }>();
		const priceOf = new Map(
			prices.results.map((row) => [row.sellable_item_id, row.price_minor]),
		);
		const amount = items.reduce(
			(sum, row) =>
				sum +
				BigInt(priceOf.get(row.sellable_item_id) ?? row.unit_price_minor) *
					BigInt(row.quantity),
			0n,
		);
		if (paymentLimitDecision(channelLimits, amount).allowed) return true;
	}
	return false;
}

/** Approved sender only: Cloudflare Email as 老实人AI VIP <no-reply@laoshirenvip.com>. */
export async function approvedFollowupSender(db: D1Database) {
	return db
		.prepare(
			`SELECT id FROM notification_channel_configs WHERE enabled = 1
			 AND channel = 'email' AND provider = 'cloudflare_email' AND from_address = ?
			 ORDER BY sort_order, id LIMIT 1`,
		)
		.bind(supportReplyEmailSender)
		.first<{ id: string }>();
}

export async function renderFollowupFor(
	db: D1Database,
	runtime: RuntimeConfig,
	assessment: Pick<
		UnpaidFollowupAssessment,
		"email" | "locale" | "item" | "usdtHint"
	>,
	brand?: string,
) {
	if (!assessment.email || !assessment.item) return null;
	const origin = renewalOrigin(runtime);
	const content = renderUnpaidFollowupEmail({
		locale: assessment.locale,
		itemName: assessment.item.name,
		usdtHint: assessment.usdtHint,
		reorderUrl: unpaidFollowupReorderUrl(
			origin,
			assessment.item.productId,
			assessment.item.sellableItemId,
		),
		supportUrl: unpaidFollowupSupportUrl(origin),
		unsubscribeUrl: await renewalUnsubscribeUrl(runtime, assessment.email),
		brand: brand ?? (await loadBrand(db)),
	});
	const oneClick = await renewalUnsubscribeUrl(
		runtime,
		assessment.email,
		"/api/shop/renewal/unsubscribe",
	);
	return {
		...content,
		headers: {
			"List-Unsubscribe": `<${oneClick}>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
		},
	};
}

export function followupIdempotencyKey(orderId: string) {
	return `unpaid_followup:${orderId}`;
}

/**
 * Cron entry (every minute). Disabled by default; when enabled it looks only
 * at orders created after activation that expired 30–60 minutes ago, records a
 * final decision per order (order_id is the primary key, so a retry or an
 * overlapping run can never send twice) and enqueues at most `limit` emails
 * through the approved sender.
 */
export async function runUnpaidOrderFollowups(
	db: D1Database,
	options: { now?: number; limit?: number; d1Budget?: number } = {},
) {
	const now = options.now ?? Date.now();
	const meter = meteredD1(db, options.d1Budget ?? unpaidFollowupD1Budget);
	const metered = meter.db;
	const settings = await loadUnpaidFollowupSettings(metered);
	if (!settings.enabled || settings.activatedAt === null)
		return { status: "disabled" as const };
	const recovered = await metered
		.prepare(
			`UPDATE unpaid_order_followups SET status = 'failed',
			 status_reason = 'stuck_sending', updated_at = ?
			 WHERE status = 'sending' AND updated_at <= ?`,
		)
		.bind(now, now - sendingTimeoutMs)
		.run();
	const sender = await approvedFollowupSender(metered);
	if (!sender) return { status: "sender_unavailable" as const };
	const candidates = await metered
		.prepare(
			`SELECT o.id FROM shop_orders o INDEXED BY shop_orders_status_expires_idx
			 WHERE o.status = 'expired' AND o.expires_at > ? AND o.expires_at <= ?
			 AND o.created_at >= ?
			 AND NOT EXISTS (SELECT 1 FROM unpaid_order_followups f WHERE f.order_id = o.id)
			 ORDER BY o.expires_at, o.id LIMIT ?`,
		)
		.bind(
			now - unpaidFollowupWindowEndMs,
			now - unpaidFollowupDelayMs,
			settings.activatedAt,
			Math.max(1, Math.min(50, options.limit ?? 10)),
		)
		.all<{ id: string }>();
	const result = {
		status: "ran" as const,
		sent: 0,
		skipped: 0,
		recovered: Number(recovered.meta.changes ?? 0),
		reasons: {} as Record<string, number>,
	};
	if (!candidates.results.length) return result;
	const runtime = await loadRuntimeConfig(metered);
	const brand = await loadBrand(metered);
	for (const candidate of candidates.results) {
		if (meter.remaining() < candidateCost) break;
		const order = await loadFollowupOrder(metered, { id: candidate.id });
		if (!order) continue;
		const assessment = await assessUnpaidOrder(metered, order, now);
		const hash = assessment.email
			? await recipientHash(assessment.email)
			: null;
		if (!assessment.eligible) {
			await recordDecision(metered, assessment, hash, "skipped", now);
			result.skipped += 1;
			const reason = assessment.reason ?? "unknown";
			result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
			continue;
		}
		const claimed = await recordDecision(
			metered,
			assessment,
			hash,
			"sending",
			now,
		);
		if (!claimed) continue;
		try {
			const content = await renderFollowupFor(
				metered,
				runtime,
				assessment,
				brand,
			);
			if (!content || !assessment.email) throw new Error("unrenderable");
			const delivery = await enqueueEmailNotification(metered, {
				event: unpaidFollowupEmailEvent,
				idempotencyKey: followupIdempotencyKey(assessment.orderId),
				configId: sender.id,
				locale: assessment.locale,
				message: {
					to: assessment.email,
					from: supportReplyEmailSender,
					replyTo: "",
					subject: content.subject,
					text: content.text,
					html: "",
					headers: content.headers,
				},
			});
			await metered
				.prepare(
					`UPDATE unpaid_order_followups SET status = 'sent', sent_at = ?,
					 notification_delivery_id = ?, updated_at = ?
					 WHERE order_id = ? AND status = 'sending'`,
				)
				.bind(now, delivery.id, now, assessment.orderId)
				.run();
			result.sent += 1;
		} catch {
			// Email storage unavailable: release the claim so the next minute
			// retries while the order is still inside its window. The delivery's
			// idempotency key keeps a retry from producing a second email.
			await metered
				.prepare(
					"DELETE FROM unpaid_order_followups WHERE order_id = ? AND status = 'sending'",
				)
				.bind(assessment.orderId)
				.run();
			break;
		}
	}
	return result;
}

async function recordDecision(
	db: D1Database,
	assessment: UnpaidFollowupAssessment,
	hash: string | null,
	status: "skipped" | "sending",
	now: number,
) {
	const inserted = await db
		.prepare(
			`INSERT INTO unpaid_order_followups
			 (order_id, recipient_hash, status, status_reason, locale, product_id,
			  sellable_item_id, usdt_hint, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(order_id) DO NOTHING`,
		)
		.bind(
			assessment.orderId,
			hash,
			status,
			assessment.reason,
			assessment.locale,
			assessment.item?.productId ?? null,
			assessment.item?.sellableItemId ?? null,
			assessment.usdtHint ? 1 : 0,
			now,
			now,
		)
		.run();
	return Number(inserted.meta.changes ?? 0) === 1;
}
