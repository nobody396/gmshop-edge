import { agentAccessProducts } from "#/features/agent-access/products";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { gptUpgradeProduct } from "#/features/gpt-upgrade/products";
import {
	enqueueEmailNotification,
	supportReplyEmailSender,
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
import { loadBrand, meteredD1 } from "#/features/renewals/server/scheduler";
import { epayCredentialSchema } from "#/features/shop-payments/provider";
import {
	channelLimits,
	channelSplitCapMinor,
} from "#/features/shop-payments/server/split";
import {
	channelPaymentAmount,
	paymentLimitDecision,
} from "#/features/shop-payments/split";
import type { SupportedLocale } from "#/lib/locales";
import { decryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig, type RuntimeConfig } from "#/server/runtime-config";
import {
	identityExclusion,
	isUnsubscribed,
	orderAnyPaymentSql,
	paymentHistory,
} from "./eligibility";
import {
	renderUnpaidFollowupEmail,
	unpaidFollowupReorderUrl,
	unpaidFollowupSupportUrl,
} from "./email";
import {
	followupIdempotencyKey,
	unpaidFollowupEmailEvent,
	unpaidFollowupKeyPrefix,
} from "./guard";
import { loadUnpaidFollowupSettings } from "./settings";

const minuteMs = 60_000;
const dayMs = 86_400_000;
/** The email goes out 30–60 minutes after the order expired unpaid. */
export const unpaidFollowupDelayMs = 30 * minuteMs;
export const unpaidFollowupWindowEndMs = 60 * minuteMs;
/** One follow-up per recipient per 30 days. */
export const unpaidFollowupRecipientCooldownMs = 30 * dayMs;
/** A claim whose outcome is still unknown after this is reconciled. */
const sendingTimeoutMs = 15 * minuteMs;
/** D1 calls one pass may make (shared per-minute cron). */
export const unpaidFollowupD1Budget = 150;
/** Worst-case D1 calls for one candidate (assessment, claim, enqueue, update). */
const candidateCost = 25;

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
	currency: string;
	currency_decimals: number;
	created_at: number;
	expires_at: number;
	paid_at: number | null;
	paid_minor: string;
	pricing_channel_id: string | null;
	any_payment: number;
	agent_api_order: number;
};

type ItemRow = {
	id: string;
	product_id: string;
	sellable_item_id: string;
	product_name: string;
	sellable_item_name: string;
	quantity: number;
	unit_price_minor: string;
	base_price_minor: string | null;
	agent_access: number;
	upgrade: number;
	sellable: number;
};

const orderColumns = `o.id, o.order_number, o.user_id,
 o.normalized_contact_email AS email, o.locale, o.status, o.currency,
 o.currency_decimals, o.created_at, o.expires_at, o.paid_at, o.paid_minor,
 o.pricing_channel_id, ${orderAnyPaymentSql("o")} AS any_payment,
 EXISTS (SELECT 1 FROM supplier_api_orders sa WHERE sa.shop_order_id = o.id) AS agent_api_order`;

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

/** Someone else holds this address's 30-day reservation. */
async function recipientReserved(
	db: D1Database,
	hash: string,
	orderId: string,
	now: number,
) {
	const row = await db
		.prepare(
			`SELECT 1 AS found FROM unpaid_followup_recipients
			 WHERE recipient_hash = ? AND order_id <> ? AND reserved_at >= ? LIMIT 1`,
		)
		.bind(hash, orderId, now - unpaidFollowupRecipientCooldownMs)
		.first<{ found: number }>();
	return Boolean(row);
}

/**
 * Applies every content rule to one order (timing and the activation cutoff
 * are the caller's job). Read-only: never writes, enqueues or sends.
 */
export async function assessUnpaidOrder(
	db: D1Database,
	order: OrderRow,
	now: number,
	commerceSecret?: string,
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
			 s.price_minor AS base_price_minor,
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
	const identity = await identityExclusion(db, order.user_id, email);
	if (identity) return skip(identity);
	const history = await paymentHistory(
		db,
		{ id: order.id, userId: order.user_id, email },
		order.created_at,
	);
	if (history.paidLater) return skip("paid_later");
	if (history.paidBefore) return skip("existing_customer");
	const hash = await recipientHash(email);
	if (await isUnsubscribed(db, hash)) return skip("unsubscribed");
	if (await recipientSuppressionReason(db, email, unpaidFollowupEmailEvent))
		return skip("suppressed");
	if (await recipientReserved(db, hash, order.id, now))
		return skip("recent_followup");
	if (!first.sellable) return skip("item_unavailable");
	const secret = commerceSecret ?? (await loadRuntimeConfig(db)).commerceSecret;
	return {
		...base,
		eligible: true,
		reason: null,
		item,
		usdtHint: await usdtToAlipayHint(db, order, items.results, now, secret),
	};
}

type AlipayChannelRow = {
	channel_id: string;
	provider: string;
	credential_encrypted: string | null;
	fee_bps: number;
	fixed_fee_minor: string;
	split_enabled: number;
	per_payment_max_minor: string;
	daily_max_minor: string;
	split_max_parts: number;
};

/** EPay is only "Alipay" when its configured payment method is alipay. */
async function epayPaysWithAlipay(
	channel: AlipayChannelRow,
	commerceSecret: string,
) {
	if (!channel.credential_encrypted || !commerceSecret) return false;
	try {
		const parsed = epayCredentialSchema.safeParse(
			JSON.parse(
				await decryptSecret(
					channel.credential_encrypted,
					commerceSecret,
					"payment-credential",
				),
			),
		);
		return parsed.success && parsed.data.paymentMethod === "alipay";
	} catch {
		return false;
	}
}

/**
 * True only when every payment channel the customer used for this order (its
 * payment attempts; the channel it was priced for when none was created) is a
 * USDT channel, and an Alipay channel can take the same items right now at the
 * amount checkout would charge (channel prices, fees and split rules, then its
 * limits). Anything uncertain omits the hint.
 */
export async function usdtToAlipayHint(
	db: D1Database,
	order: Pick<
		OrderRow,
		"id" | "pricing_channel_id" | "currency" | "currency_decimals"
	>,
	items: Array<
		Pick<
			ItemRow,
			"sellable_item_id" | "quantity" | "unit_price_minor" | "base_price_minor"
		>
	>,
	now: number,
	commerceSecret: string,
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
	// Alipay pays CNY; another store currency would need a conversion quote.
	if (order.currency !== "CNY" || order.currency_decimals !== 2) return false;
	const channels = await db
		.prepare(
			`SELECT id AS channel_id, provider, credential_encrypted, fee_bps,
			 fixed_fee_minor, split_enabled, per_payment_max_minor, daily_max_minor,
			 split_max_parts FROM payment_channels
			 WHERE enabled = 1 AND provider IN ('epay','alipay_page','alipay_wap','alipay_qr')
			 ORDER BY sort_order, id`,
		)
		.all<AlipayChannelRow>();
	for (const channel of channels.results) {
		if (
			channel.provider === "epay" &&
			!(await epayPaysWithAlipay(channel, commerceSecret))
		)
			continue;
		const prices = await db
			.prepare(
				`SELECT sellable_item_id, price_minor FROM sellable_item_channel_prices
				 WHERE channel_id = ? AND enabled = 1`,
			)
			.bind(channel.channel_id)
			.all<{ sellable_item_id: string; price_minor: string }>();
		const priceOf = new Map(
			prices.results.map((row) => [row.sellable_item_id, row.price_minor]),
		);
		// Same quote as checkout: channel price (else the item's base price);
		// channel fees apply unless every item has a channel price.
		const fixedPricing = items.every((row) =>
			priceOf.has(row.sellable_item_id),
		);
		const goods = items.reduce(
			(sum, row) =>
				sum +
				BigInt(
					priceOf.get(row.sellable_item_id) ??
						row.base_price_minor ??
						row.unit_price_minor,
				) *
					BigInt(row.quantity),
			0n,
		);
		let total: string;
		try {
			total = channelPaymentAmount(
				goods.toString(),
				fixedPricing ? 0 : channel.fee_bps,
				fixedPricing ? "0" : channel.fixed_fee_minor,
				channelSplitCapMinor(channel),
			);
		} catch {
			continue;
		}
		const limits = await channelLimits(db, channel, now);
		if (!limits || paymentLimitDecision(limits, total).allowed) return true;
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

/**
 * Atomically claims the order AND the recipient's 30-day reservation in one
 * D1 batch (a transaction). The reservation row is keyed by the email hash, so
 * two overlapping runs can never claim two orders for one address; an old
 * reservation (≥ 30 days) is taken over. Returns false when either is held.
 */
export async function claimFollowup(
	db: D1Database,
	assessment: UnpaidFollowupAssessment,
	hash: string,
	activationAt: number,
	now: number,
) {
	const [, inserted] = await db.batch([
		db
			.prepare(
				`INSERT INTO unpaid_followup_recipients (recipient_hash, order_id, reserved_at)
				 VALUES (?, ?, ?)
				 ON CONFLICT(recipient_hash) DO UPDATE SET order_id = excluded.order_id,
				 reserved_at = excluded.reserved_at
				 WHERE unpaid_followup_recipients.reserved_at < ?`,
			)
			.bind(
				hash,
				assessment.orderId,
				now,
				now - unpaidFollowupRecipientCooldownMs,
			),
		db
			.prepare(
				`INSERT INTO unpaid_order_followups
				 (order_id, recipient_hash, status, status_reason, locale, product_id,
				  sellable_item_id, usdt_hint, activation_at, created_at, updated_at)
				 SELECT ?, ?, 'sending', NULL, ?, ?, ?, ?, ?, ?, ?
				 WHERE EXISTS (SELECT 1 FROM unpaid_followup_recipients
				  WHERE recipient_hash = ? AND order_id = ? AND reserved_at = ?)
				 ON CONFLICT(order_id) DO NOTHING`,
			)
			.bind(
				assessment.orderId,
				hash,
				assessment.locale,
				assessment.item?.productId ?? null,
				assessment.item?.sellableItemId ?? null,
				assessment.usdtHint ? 1 : 0,
				activationAt,
				now,
				now,
				hash,
				assessment.orderId,
				now,
			),
	]);
	return Number(inserted?.meta.changes ?? 0) === 1;
}

/**
 * Settles a 'sending' claim from durable state: a delivery row with the
 * order's idempotency key means the email is queued ('sent'); none means it
 * never was ('failed'). Either way the recipient reservation is kept, so an
 * uncertain or attempted send still counts toward the 30-day cooldown.
 */
function settleClaims(
	db: D1Database,
	where: { orderId: string } | { olderThan: number },
	reason: string,
	now: number,
) {
	const delivery = `(SELECT nd.id FROM notification_deliveries nd
	 WHERE nd.idempotency_key = '${unpaidFollowupKeyPrefix}' || unpaid_order_followups.order_id)`;
	return db
		.prepare(
			`UPDATE unpaid_order_followups SET
			 notification_delivery_id = ${delivery},
			 status = CASE WHEN ${delivery} IS NOT NULL THEN 'sent' ELSE 'failed' END,
			 status_reason = CASE WHEN ${delivery} IS NOT NULL THEN NULL ELSE ? END,
			 sent_at = CASE WHEN ${delivery} IS NOT NULL THEN COALESCE(sent_at, ?) END,
			 updated_at = ?
			 WHERE status = 'sending' AND ${"orderId" in where ? "order_id = ?" : "updated_at <= ?"}`,
		)
		.bind(
			reason,
			now,
			now,
			"orderId" in where ? where.orderId : where.olderThan,
		)
		.run();
}

/**
 * Cron entry (every minute). Disabled by default; when enabled it looks only
 * at orders created after activation that expired 30–60 minutes ago, records a
 * final decision per order and enqueues at most `limit` emails through the
 * approved sender. The delivery path re-checks eligibility right before the
 * provider (see guard.ts), so a queued email never goes to someone who paid,
 * unsubscribed or was switched off in the meantime.
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
	const recovered = await settleClaims(
		metered,
		{ olderThan: now - sendingTimeoutMs },
		"stuck_sending",
		now,
	);
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
	const skipped = async (assessment: UnpaidFollowupAssessment) => {
		await recordSkip(metered, assessment, now);
		result.skipped += 1;
		const reason = assessment.reason ?? "unknown";
		result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
	};
	for (const candidate of candidates.results) {
		if (meter.remaining() < candidateCost) break;
		const order = await loadFollowupOrder(metered, { id: candidate.id });
		if (!order) continue;
		const assessment = await assessUnpaidOrder(
			metered,
			order,
			now,
			runtime.commerceSecret,
		);
		if (!assessment.eligible || !assessment.email) {
			await skipped(assessment);
			continue;
		}
		const hash = await recipientHash(assessment.email);
		if (
			!(await claimFollowup(
				metered,
				assessment,
				hash,
				settings.activatedAt,
				now,
			))
		) {
			// Lost the race for this order or for the address's reservation.
			const own = await metered
				.prepare(
					"SELECT 1 AS found FROM unpaid_order_followups WHERE order_id = ?",
				)
				.bind(assessment.orderId)
				.first<{ found: number }>();
			if (!own)
				await skipped({
					...assessment,
					eligible: false,
					reason: "recent_followup",
					usdtHint: false,
				});
			continue;
		}
		try {
			const content = await renderFollowupFor(
				metered,
				runtime,
				assessment,
				brand,
			);
			if (!content) throw new Error("unrenderable");
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
			// Outcome uncertain: never release the claim or the reservation.
			// Settle from durable delivery state now; if even that fails the row
			// stays 'sending' and the next run's recovery settles it.
			await settleClaims(
				metered,
				{ orderId: assessment.orderId },
				"enqueue_failed",
				now,
			).catch(() => undefined);
			break;
		}
	}
	return result;
}

async function recordSkip(
	db: D1Database,
	assessment: UnpaidFollowupAssessment,
	now: number,
) {
	await db
		.prepare(
			`INSERT INTO unpaid_order_followups
			 (order_id, recipient_hash, status, status_reason, locale, product_id,
			  sellable_item_id, usdt_hint, created_at, updated_at)
			 VALUES (?, ?, 'skipped', ?, ?, ?, ?, 0, ?, ?)
			 ON CONFLICT(order_id) DO NOTHING`,
		)
		.bind(
			assessment.orderId,
			assessment.email ? await recipientHash(assessment.email) : null,
			assessment.reason,
			assessment.locale,
			assessment.item?.productId ?? null,
			assessment.item?.sellableItemId ?? null,
			now,
			now,
		)
		.run();
}
