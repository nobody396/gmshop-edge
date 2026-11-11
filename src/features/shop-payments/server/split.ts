import { paymentProcessingFeeAmount } from "#/features/shop-payments/fees";
import type {
	CreatedPayment,
	CreatePaymentInput,
	PaymentRefund,
	PaymentWebhookEvent,
} from "#/features/shop-payments/provider";
import { getPaymentProvider } from "#/features/shop-payments/providers";
import { closeAlipayTrade } from "#/features/shop-payments/providers/alipay";
import {
	loadCredential,
	type PaymentEventResult,
	paymentEventStatement,
	presentPaymentReplayReceipt,
	processShopPaymentEvent,
	runPaymentEventBatch,
} from "#/features/shop-payments/server/service";
import {
	beijingDayStart,
	type PaymentChannelLimits,
	paymentLimitDecision,
	splitOrderExpiry,
	splitPaymentAmount,
	splitPaymentProviders,
} from "#/features/shop-payments/split";
import { sendOwnerAlert } from "#/features/telegram/server/owner-alerts";
import { DomainError } from "#/lib/domain-error";
import { decimalToMinor, minorToDecimal } from "#/lib/units";

/**
 * Split payments (Alipay 订单码支付 over the single-payment limit).
 *
 * The order keeps exactly one payment_attempts row for the whole amount (the
 * "parent", provider_payment_id `split:<id>`); every consumer of paid orders
 * (fulfilment, emails, referral, profit, Telegram, reports) sees one payment
 * with the full total. Each part is its own Alipay trade in
 * payment_split_parts and is created only after the previous part is paid. The
 * parent succeeds — through the normal order-paid transition — only when every
 * part is paid before the order's deadline. Paid parts of an order that
 * expires or is cancelled first are refunded automatically
 * (payment_split_refunds) and reported to the owner.
 */

type ChannelLimitRow = {
	channel_id: string;
	provider: string;
	split_enabled: number;
	per_payment_max_minor: string;
	daily_max_minor: string;
	split_max_parts: number;
};

const maxAutomaticRefundAttempts = 3;
const refundLeaseMs = 120_000;
const retryableRefundCodes = new Set([
	"20000",
	"ACQ.SYSTEM_ERROR",
	"aop.ACQ.SYSTEM_ERROR",
	"isp.unknow-error",
]);
const reconcileWindowMs = 2 * 60 * 60_000;
const settleWindowMs = 2 * 24 * 60 * 60_000;
const checkBackoffMs = 5 * 60_000;

export function channelUsesPaymentLimits(provider: string) {
	return splitPaymentProviders.has(provider);
}

/**
 * Best-effort estimate of a channel's use of today's limit (Beijing day). The
 * daily limit is a customer-experience guard, not a money guard: Alipay
 * enforces the real limit, and parts of a plan Alipay refuses are refunded on
 * expiry. Counted: payments collected today by actual payment time (single
 * payments and split parts), plus what is still unpaid on split plans that
 * are open (started, not expired, not fully paid). Checked only when a
 * payment or a plan's first part is created; later parts are not checked.
 */
export async function channelDailyUsageMinor(
	db: D1Database,
	channelId: string,
	now = Date.now(),
) {
	const from = beijingDayStart(now);
	const to = from + 86_400_000;
	const row = await db
		.prepare(
			`SELECT
			 COALESCE((SELECT SUM(CAST(amount_minor AS INTEGER)) FROM payment_attempts
			  WHERE channel_id=? AND status='succeeded' AND split_part_count IS NULL
			   AND succeeded_at>=? AND succeeded_at<?),0)
			 + COALESCE((SELECT SUM(CAST(amount_minor AS INTEGER)) FROM payment_split_parts
			  WHERE channel_id=? AND status='succeeded'
			   AND succeeded_at>=? AND succeeded_at<?),0)
			 + COALESCE((SELECT SUM(CAST(part.amount_minor AS INTEGER))
			  FROM payment_split_parts part
			  JOIN payment_attempts pa ON pa.id=part.payment_attempt_id
			  JOIN shop_orders o ON o.id=pa.order_id
			  WHERE part.channel_id=? AND part.status<>'succeeded'
			   AND pa.status IN ('created','pending')
			   AND o.status='pending_payment' AND o.expires_at>?),0) AS total`,
		)
		.bind(channelId, from, to, channelId, from, to, channelId, now)
		.first<{ total: number | string | null }>();
	return BigInt(String(row?.total ?? 0));
}

export async function channelLimits(
	db: D1Database,
	channel: ChannelLimitRow,
	now = Date.now(),
): Promise<PaymentChannelLimits | null> {
	if (!channelUsesPaymentLimits(channel.provider)) return null;
	const dailyMax = BigInt(channel.daily_max_minor || "0");
	let dailyRemainingMinor: string | null = null;
	if (dailyMax > 0n) {
		const used = await channelDailyUsageMinor(db, channel.channel_id, now);
		dailyRemainingMinor = (dailyMax > used ? dailyMax - used : 0n).toString();
	}
	return {
		perPaymentMaxMinor: channel.per_payment_max_minor || "0",
		splitEnabled: Boolean(channel.split_enabled),
		splitMaxParts: Number(channel.split_max_parts) || 0,
		dailyRemainingMinor,
	};
}

export function limitError(reason: string) {
	return new DomainError(
		"payment_channel_limit_exceeded",
		409,
		reason === "daily_limit"
			? "This payment method has reached today's limit"
			: "The amount exceeds this payment method's limit",
	);
}

/** Single-payment cap used to split, or null when the channel never splits. */
export function channelSplitCapMinor(channel: ChannelLimitRow) {
	return channelUsesPaymentLimits(channel.provider) &&
		Boolean(channel.split_enabled) &&
		BigInt(channel.per_payment_max_minor || "0") > 0n
		? channel.per_payment_max_minor
		: null;
}

/**
 * Applies a QR channel's limits to a new order payment. Returns the part
 * amounts when the payment must be split, null for one ordinary payment.
 */
export async function planChannelPayment(
	db: D1Database,
	channel: ChannelLimitRow & { fee_bps: number; fixed_fee_minor: string },
	quote: { amountMinor: string; currency: string; currencyDecimals: number },
	now = Date.now(),
) {
	const limits = await channelLimits(db, channel, now);
	if (!limits) return null;
	const decision = paymentLimitDecision(limits, quote.amountMinor);
	if (!decision.allowed) throw limitError(decision.reason);
	if (decision.parts === 1) return null;
	if (quote.currency !== "CNY" || quote.currencyDecimals !== 2)
		throw limitError("per_payment_limit");
	const parts = splitPaymentAmount(
		quote.amountMinor,
		limits.perPaymentMaxMinor,
	);
	const processingFeeMinor = parts
		.reduce(
			(sum, part) =>
				sum +
				BigInt(
					paymentProcessingFeeAmount(
						part,
						channel.fee_bps,
						channel.fixed_fee_minor,
					),
				),
			0n,
		)
		.toString();
	return { parts, processingFeeMinor };
}

/** Wallet top-ups are never split: they only have to fit the limits. */
export async function walletTopupLimits(
	db: D1Database,
	channelId: string,
	amountMinor: string,
	now = Date.now(),
) {
	const channel = await db
		.prepare(
			`SELECT id AS channel_id, provider, split_enabled, per_payment_max_minor,
			 daily_max_minor, split_max_parts FROM payment_channels WHERE id=? LIMIT 1`,
		)
		.bind(channelId)
		.first<ChannelLimitRow>();
	if (!channel) return null;
	const limits = await channelLimits(db, channel, now);
	if (!limits) return null;
	const decision = paymentLimitDecision(limits, amountMinor, {
		allowSplit: false,
	});
	if (!decision.allowed) throw limitError(decision.reason);
}

/** Channel limits for the checkout page, keyed by channel id. */
export async function checkoutChannelLimits(
	db: D1Database,
	channels: Array<{
		id: string;
		provider: string;
		split_enabled?: number | null;
		per_payment_max_minor?: string | null;
		daily_max_minor?: string | null;
		split_max_parts?: number | null;
	}>,
	now = Date.now(),
) {
	const result = new Map<string, PaymentChannelLimits>();
	for (const channel of channels) {
		const limits = await channelLimits(
			db,
			{
				channel_id: channel.id,
				provider: channel.provider,
				split_enabled: Number(channel.split_enabled ?? 0),
				per_payment_max_minor: channel.per_payment_max_minor ?? "0",
				daily_max_minor: channel.daily_max_minor ?? "0",
				split_max_parts: Number(channel.split_max_parts ?? 10),
			},
			now,
		);
		if (limits) result.set(channel.id, limits);
	}
	return result;
}

/**
 * A channel has split payments that are not settled yet: a plan still being
 * paid, a part not closed, or money on an unfinished plan not fully refunded.
 * Its payment product must not change meanwhile.
 */
export async function channelHasUnsettledSplitPayments(
	db: D1Database,
	channelId: string,
) {
	const row = await db
		.prepare(
			`SELECT 1 AS open FROM payment_split_parts part
			 JOIN payment_attempts pa ON pa.id = part.payment_attempt_id
			 WHERE part.channel_id = ? AND (
			  pa.status IN ('created','pending')
			  OR part.status IN ('created','pending')
			  OR (part.status IN ('expired','failed') AND part.provider_payment_id IS NOT NULL)
			  OR (part.status = 'succeeded' AND pa.status <> 'succeeded'
			   AND CAST(part.refunded_minor AS INTEGER) < CAST(part.amount_minor AS INTEGER))
			  OR EXISTS (SELECT 1 FROM payment_split_refunds refund
			   WHERE refund.part_id = part.id AND refund.status IN ('pending','failed','manual'))
			 ) LIMIT 1`,
		)
		.bind(channelId)
		.first();
	return Boolean(row);
}

/**
 * Creates the part rows and the first part's provider trade for a new parent
 * attempt (still `created`). Split orders get more time: 15 minutes per part,
 * at most two hours, never less than the order already had.
 */
export async function startSplitPayment(
	db: D1Database,
	input: {
		channelId: string;
		provider: string;
		parts: string[];
		payment: CreatePaymentInput;
		credential: unknown;
		fetcher: typeof fetch;
		now: number;
	},
): Promise<CreatedPayment> {
	const { payment, parts, now } = input;
	const expiresAt = splitOrderExpiry(
		payment.expiresAt ?? now,
		parts.length,
		now,
	);
	const partIds = parts.map(() => crypto.randomUUID());
	const [, ...inserted] = await db.batch([
		// GPT upgrade orders are capped by their price ticket and keep their expiry.
		db
			.prepare(
				`UPDATE shop_orders SET expires_at=MAX(expires_at, ?), updated_at=?
				 WHERE id=? AND status='pending_payment' AND NOT EXISTS (
				  SELECT 1 FROM shop_order_items item
				  JOIN gpt_upgrade_orders upgrade ON upgrade.order_item_id=item.id
				  WHERE item.order_id=shop_orders.id)`,
			)
			.bind(expiresAt, now, payment.orderId),
		...parts.map((amountMinor, index) =>
			db
				.prepare(
					`INSERT INTO payment_split_parts
					 (id, payment_attempt_id, channel_id, part_index, part_count, amount_minor,
					  notify_url, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					partIds[index],
					payment.attemptId,
					input.channelId,
					index + 1,
					parts.length,
					amountMinor,
					payment.webhookUrl,
					index === 0 ? "pending" : "created",
					now,
					now,
				),
		),
		db
			.prepare("SELECT expires_at FROM shop_orders WHERE id=?")
			.bind(payment.orderId),
	]);
	const order = inserted.at(-1)?.results[0] as
		| { expires_at: number }
		| undefined;
	const first = await createPartTrade(db, {
		partId: partIds[0] as string,
		partIndex: 1,
		partCount: parts.length,
		amountMinor: parts[0] as string,
		provider: input.provider,
		payment: { ...payment, expiresAt: order?.expires_at ?? payment.expiresAt },
		credential: input.credential,
		fetcher: input.fetcher,
	});
	return {
		providerPaymentId: `split:${payment.attemptId}`,
		checkoutUrl: first.checkoutUrl,
		expiresAt: first.expiresAt,
	};
}

async function createPartTrade(
	db: D1Database,
	input: {
		partId: string;
		partIndex: number;
		partCount: number;
		amountMinor: string;
		provider: string;
		payment: CreatePaymentInput;
		credential: unknown;
		fetcher: typeof fetch;
	},
) {
	try {
		const created = await getPaymentProvider(input.provider).createPayment(
			{
				...input.payment,
				attemptId: input.partId,
				amountMinor: input.amountMinor,
				description: `${input.payment.description} (${input.partIndex}/${input.partCount})`,
			},
			input.credential,
			input.fetcher,
		);
		await db
			.prepare(
				`UPDATE payment_split_parts SET provider_payment_id=?, checkout_url=?,
				 provider_expires_at=?, status='pending', failure_code=NULL, updated_at=?
				 WHERE id=? AND status='pending'`,
			)
			.bind(
				created.providerPaymentId,
				created.checkoutUrl,
				created.expiresAt,
				Date.now(),
				input.partId,
			)
			.run();
		return created;
	} catch (error) {
		await db
			.prepare(
				`UPDATE payment_split_parts SET status='failed', failure_code=?, updated_at=?
				 WHERE id=? AND status='pending'`,
			)
			.bind(
				error instanceof DomainError ? error.code : "provider_create_failed",
				Date.now(),
				input.partId,
			)
			.run();
		throw error;
	}
}

type ParentRow = {
	id: string;
	status: string;
	channel_id: string;
	order_id: string;
	checkout_url: string | null;
	provider_payment_id: string;
	amount_minor: string;
	currency: string;
	currency_decimals: number;
	split_part_count: number;
	order_status: string;
	order_number: string;
	order_expires_at: number;
	contact_email: string | null;
	provider: string;
	credential_encrypted: string | null;
	paid_parts: number;
};

async function loadParent(db: D1Database, attemptId: string) {
	return db
		.prepare(
			`SELECT pa.id, pa.status, pa.channel_id, pa.order_id, pa.checkout_url,
			 pa.provider_payment_id, pa.amount_minor, pa.currency, pa.currency_decimals,
			 pa.split_part_count, o.status AS order_status, o.order_number,
			 o.expires_at AS order_expires_at, o.contact_email,
			 pc.provider, pc.credential_encrypted,
			 (SELECT COUNT(*) FROM payment_split_parts part
			  WHERE part.payment_attempt_id=pa.id AND part.status='succeeded') AS paid_parts
			 FROM payment_attempts pa JOIN shop_orders o ON o.id=pa.order_id
			 JOIN payment_channels pc ON pc.id=pa.channel_id
			 WHERE pa.id=? AND pa.split_part_count IS NOT NULL LIMIT 1`,
		)
		.bind(attemptId)
		.first<ParentRow>();
}

/**
 * Completes the order once every part is paid, through the same order-paid
 * transition as a single payment (idempotent: one completion event per parent).
 * The order must still be awaiting payment and inside its deadline — checked
 * again inside the order-paid batch — otherwise nothing is fulfilled and the
 * paid parts are refunded by settleSplitPayments.
 */
export async function completeSplitPaymentIfReady(
	db: D1Database,
	attemptId: string,
	now = Date.now(),
): Promise<PaymentEventResult | null> {
	const parent = await loadParent(db, attemptId);
	if (
		!parent ||
		parent.status !== "pending" ||
		parent.order_status !== "pending_payment" ||
		parent.order_expires_at <= now ||
		Number(parent.paid_parts) < Number(parent.split_part_count)
	)
		return null;
	return processShopPaymentEvent(
		db,
		parent.channel_id,
		{
			providerEventId: `split-complete:${parent.id}`,
			providerPaymentId: parent.provider_payment_id,
			type: "payment_succeeded",
			amountMinor: parent.amount_minor,
			currency: parent.currency,
			merchantOrderId: null,
			payloadDigest: `split-complete:${parent.id}`,
		},
		{ requirePendingOrder: true, now },
	);
}

/**
 * Makes sure the next unpaid part has a live QR on the parent attempt (the
 * order page shows the parent's checkout URL). Safe to call repeatedly. The
 * plan (part count, amounts, fee snapshot) was frozen when it was created; the
 * daily limit is not checked again for later parts.
 */
export async function ensureNextSplitPart(
	db: D1Database,
	attemptId: string,
	fetcher: typeof fetch = fetch,
	now = Date.now(),
) {
	const parent = await loadParent(db, attemptId);
	if (
		!parent ||
		parent.status !== "pending" ||
		parent.order_status !== "pending_payment" ||
		parent.order_expires_at <= now ||
		// The channel's product is frozen while plans are open (see admin save).
		!channelUsesPaymentLimits(parent.provider)
	)
		return null;
	const next = await db
		.prepare(
			`SELECT id, part_index, part_count, amount_minor, status, checkout_url,
			 provider_expires_at, notify_url, updated_at FROM payment_split_parts
			 WHERE payment_attempt_id=? AND status<>'succeeded'
			 ORDER BY part_index LIMIT 1`,
		)
		.bind(attemptId)
		.first<{
			id: string;
			part_index: number;
			part_count: number;
			amount_minor: string;
			status: string;
			checkout_url: string | null;
			provider_expires_at: number | null;
			notify_url: string;
			updated_at: number;
		}>();
	if (!next || ["expired", "closed"].includes(next.status)) return null;
	if (next.status === "pending" && next.checkout_url) {
		if (parent.checkout_url !== next.checkout_url)
			await showPartOnParent(db, parent.id, next, now);
		return next.id;
	}
	const claim = await db
		.prepare(
			`UPDATE payment_split_parts SET status='pending', failure_code=NULL, updated_at=?
			 WHERE id=? AND (status IN ('created','failed')
			  OR (status='pending' AND checkout_url IS NULL AND updated_at<?))`,
		)
		.bind(now, next.id, now - 30_000)
		.run();
	if (Number(claim.meta.changes ?? 0) !== 1) return null;
	const credential = await loadCredential(db, parent.credential_encrypted);
	const created = await createPartTrade(db, {
		partId: next.id,
		partIndex: next.part_index,
		partCount: next.part_count,
		amountMinor: next.amount_minor,
		provider: parent.provider,
		payment: {
			attemptId: parent.id,
			orderId: parent.order_id,
			orderNumber: parent.order_number,
			amountMinor: next.amount_minor,
			currency: parent.currency,
			currencyDecimals: parent.currency_decimals,
			customerEmail: parent.contact_email ?? "",
			description: `Order ${parent.order_number}`,
			successUrl: next.notify_url,
			cancelUrl: next.notify_url,
			webhookUrl: next.notify_url,
			defaultToken: "",
			defaultNetwork: "",
			payerIp: null,
			expiresAt: parent.order_expires_at,
		},
		credential,
		fetcher,
	});
	await showPartOnParent(
		db,
		parent.id,
		{
			checkout_url: created.checkoutUrl,
			provider_expires_at: created.expiresAt,
		},
		now,
	);
	return next.id;
}

function showPartOnParent(
	db: D1Database,
	attemptId: string,
	part: { checkout_url: string | null; provider_expires_at: number | null },
	now: number,
) {
	return db
		.prepare(
			`UPDATE payment_attempts SET checkout_url=?, provider_expires_at=?, updated_at=?
			 WHERE id=? AND status='pending'`,
		)
		.bind(part.checkout_url, part.provider_expires_at, now, attemptId)
		.run();
}

type PartContext = {
	id: string;
	payment_attempt_id: string;
	part_index: number;
	part_count: number;
	amount_minor: string;
	status: string;
	checkout_url: string | null;
	provider_payment_id: string;
	provider_trade_no: string | null;
	attempt_status: string;
	currency: string;
	currency_decimals: number;
	order_status: string;
	order_expires_at: number;
};

/**
 * Handles a provider event for one part. Returns null when the event is not
 * for a split part (the caller continues with the single-payment flow).
 */
export async function processSplitPartEvent(
	db: D1Database,
	channelId: string,
	event: PaymentWebhookEvent,
	fetcher: typeof fetch = fetch,
	now = Date.now(),
): Promise<PaymentEventResult | null> {
	const part = await db
		.prepare(
			`SELECT part.id, part.payment_attempt_id, part.part_index, part.part_count,
			 part.amount_minor, part.status, part.checkout_url, part.provider_payment_id,
			 part.provider_trade_no, pa.status AS attempt_status, pa.currency,
			 pa.currency_decimals, o.status AS order_status, o.expires_at AS order_expires_at
			 FROM payment_split_parts part
			 JOIN payment_attempts pa ON pa.id=part.payment_attempt_id
			 JOIN shop_orders o ON o.id=pa.order_id
			 WHERE part.channel_id=? AND part.provider_payment_id=? LIMIT 1`,
		)
		.bind(channelId, event.providerPaymentId)
		.first<PartContext>();
	if (!part) return null;
	const receipt = (status: "processed" | "rejected") =>
		paymentEventStatement(
			db,
			channelId,
			part.payment_attempt_id,
			event,
			status,
			now,
		);
	const run = async (
		statements: D1PreparedStatement[],
		status: string,
	): Promise<PaymentEventResult> => {
		const result = await runPaymentEventBatch(db, channelId, event, statements);
		if (result.duplicate)
			return presentPaymentReplayReceipt(result.duplicate, event);
		return { duplicate: false, status };
	};
	if (event.type === "payment_pending" || event.type === "payment_failed")
		// An unpaid QR stays payable until the order expires.
		return run([receipt("processed")], "pending");
	if (event.type === "payment_expired")
		return run(
			[
				receipt("processed"),
				db
					.prepare(
						`UPDATE payment_split_parts SET status='expired', failure_code='provider_closed',
						 updated_at=? WHERE id=? AND status IN ('created','pending')`,
					)
					.bind(now, part.id),
			],
			"expired",
		);
	validatePartPayment(part, event);
	const tradeNo = event.providerTradeNo ?? null;
	const late =
		part.attempt_status !== "pending" ||
		part.order_status !== "pending_payment" ||
		part.order_expires_at <= now;
	if (late) {
		// The money is real but the order can no longer be paid (expired,
		// cancelled, or past its deadline even if expiry has not run yet): never
		// fulfil. Recorded for review; settleSplitPayments refunds it and alerts.
		return run(
			[
				receipt("rejected"),
				db
					.prepare(
						`UPDATE payment_split_parts SET status='succeeded',
						 succeeded_at=COALESCE(succeeded_at, ?), failure_code='late_payment',
						 provider_trade_no=COALESCE(provider_trade_no, ?), updated_at=?
						 WHERE id=? AND status<>'succeeded'`,
					)
					.bind(now, tradeNo, now, part.id),
				db
					.prepare(
						`UPDATE payment_attempts SET failure_code='split_late_payment', updated_at=?
						 WHERE id=? AND status<>'succeeded'`,
					)
					.bind(now, part.payment_attempt_id),
				db
					.prepare(
						`INSERT INTO audit_logs (id, action, target_type, target_id, after, created_at)
						 VALUES (?, 'payment.split_late_payment', 'payment_attempt', ?, ?, ?)`,
					)
					.bind(
						crypto.randomUUID(),
						part.payment_attempt_id,
						JSON.stringify({
							partIndex: part.part_index,
							partCount: part.part_count,
							amountMinor: part.amount_minor,
							orderStatus: part.order_status,
							attemptStatus: part.attempt_status,
							pastDeadline: part.order_expires_at <= now,
						}),
						now,
					),
			],
			"reconciliation_required",
		);
	}
	const recorded = await run(
		[
			receipt("processed"),
			db
				.prepare(
					`UPDATE payment_split_parts SET status='succeeded', succeeded_at=?,
					 provider_trade_no=COALESCE(provider_trade_no, ?), failure_code=NULL,
					 updated_at=? WHERE id=? AND status<>'succeeded'`,
				)
				.bind(now, tradeNo, now, part.id),
			// Hide the paid QR; the next part's QR replaces it.
			db
				.prepare(
					`UPDATE payment_attempts SET checkout_url=NULL, updated_at=?
					 WHERE id=? AND status='pending' AND checkout_url IS ?`,
				)
				.bind(now, part.payment_attempt_id, part.checkout_url),
		],
		"split_part_succeeded",
	);
	if (recorded.duplicate) return recorded;
	const completed = await completeSplitPaymentIfReady(
		db,
		part.payment_attempt_id,
		now,
	).catch((error: unknown) => {
		// Retried by the order page and settleSplitPayments; a deadline miss
		// leaves the order to expire and be refunded.
		logSplitFailure("split_completion_failed", part.payment_attempt_id, error);
		return null;
	});
	if (completed) return { duplicate: false, status: completed.status };
	await ensureNextSplitPart(db, part.payment_attempt_id, fetcher, now).catch(
		(error: unknown) =>
			logSplitFailure("split_next_part_failed", part.payment_attempt_id, error),
	);
	return recorded;
}

function validatePartPayment(part: PartContext, event: PaymentWebhookEvent) {
	let decimalMinor: string | null = null;
	try {
		decimalMinor =
			event.amountDecimal == null
				? null
				: decimalToMinor(
						event.amountDecimal,
						part.currency_decimals,
					).toString();
	} catch {
		decimalMinor = "invalid";
	}
	if (
		(event.amountMinor == null && decimalMinor == null) ||
		(event.amountMinor != null && event.amountMinor !== part.amount_minor) ||
		(decimalMinor != null && decimalMinor !== part.amount_minor) ||
		(event.currency != null &&
			event.currency.toUpperCase() !== part.currency.toUpperCase()) ||
		(event.merchantOrderId != null &&
			event.merchantOrderId !== part.provider_payment_id) ||
		// Once known, the Alipay trade number of a part never changes.
		(part.provider_trade_no != null &&
			event.providerTradeNo != null &&
			event.providerTradeNo !== part.provider_trade_no)
	)
		throw new DomainError(
			"payment_amount_mismatch",
			400,
			"Payment amount mismatch",
		);
}

function logSplitFailure(event: string, attemptId: string, error: unknown) {
	console.error(
		JSON.stringify({
			event,
			attemptId,
			errorCode: error instanceof DomainError ? error.code : "unexpected_error",
		}),
	);
}

/**
 * Order page / retry entry: finishes a fully paid split payment, checks the
 * current part with the provider (missed callbacks) and shows the next QR.
 */
export async function resumeSplitPayment(
	db: D1Database,
	orderId: string,
	fetcher: typeof fetch = fetch,
	now = Date.now(),
) {
	const parent = await db
		.prepare(
			`SELECT id FROM payment_attempts WHERE order_id=? AND split_part_count IS NOT NULL
			 AND status='pending' ORDER BY created_at DESC, id DESC LIMIT 1`,
		)
		.bind(orderId)
		.first<{ id: string }>();
	if (!parent) return { split: false as const, completed: false };
	await reconcileSplitParts(db, fetcher, now, {
		attemptId: parent.id,
		minIdleMs: 3_000,
		limit: 1,
	});
	const completed = await completeSplitPaymentIfReady(db, parent.id, now).catch(
		(error: unknown) => {
			logSplitFailure("split_completion_failed", parent.id, error);
			return null;
		},
	);
	if (!completed)
		await ensureNextSplitPart(db, parent.id, fetcher, now).catch(
			(error: unknown) =>
				logSplitFailure("split_next_part_failed", parent.id, error),
		);
	return { split: true as const, completed: Boolean(completed) };
}

type CheckablePart = {
	id: string;
	channel_id: string;
	provider_payment_id: string;
	amount_minor: string;
	currency: string;
	provider: string;
	credential_encrypted: string | null;
};

/**
 * A provider query that failed: back off this part so other candidates (and
 * other channels) get their turn in the next bounded scan.
 */
function deferPartCheck(db: D1Database, partId: string, now: number) {
	return db
		.prepare(
			"UPDATE payment_split_parts SET next_check_at=?, updated_at=? WHERE id=? AND status<>'succeeded'",
		)
		.bind(now + checkBackoffMs, now, partId)
		.run();
}

/**
 * Records a part the provider reports as paid. The query result must name the
 * same trade and carry the paid amount; anything else is left for review.
 */
async function recordQueriedPayment(
	db: D1Database,
	part: CheckablePart,
	query: Awaited<
		ReturnType<ReturnType<typeof getPaymentProvider>["queryPayment"]>
	>,
) {
	if (query.amountMinor == null)
		throw new DomainError(
			"payment_provider_invalid_response",
			502,
			"Paid trade without an amount",
		);
	await processShopPaymentEvent(db, part.channel_id, {
		providerEventId: `payment-reconcile:${part.channel_id}:${part.id}`,
		providerPaymentId: part.provider_payment_id,
		type: "payment_succeeded",
		amountMinor: query.amountMinor,
		currency: query.currency ?? part.currency,
		merchantOrderId: part.provider_payment_id,
		providerTradeNo: query.providerTradeNo ?? null,
		payloadDigest: `payment-reconcile:${part.id}`,
	});
}

/** Queries pending parts with the provider; a paid part goes through the event path. */
async function reconcileSplitParts(
	db: D1Database,
	fetcher: typeof fetch,
	now: number,
	scope: { attemptId?: string; minIdleMs: number; limit: number },
) {
	const parts = await db
		.prepare(
			`SELECT part.id, part.channel_id, part.provider_payment_id, part.amount_minor,
			 pa.currency, pc.provider, pc.credential_encrypted
			 FROM payment_split_parts part
			 JOIN payment_attempts pa ON pa.id=part.payment_attempt_id
			 JOIN shop_orders o ON o.id=pa.order_id
			 JOIN payment_channels pc ON pc.id=part.channel_id
			 WHERE part.status='pending' AND part.provider_payment_id IS NOT NULL
			  -- Parts of orders that can no longer be paid (cancelled, expired,
			  -- refunded…) are queried and closed by closeDeadParts only.
			  AND pa.status='pending' AND o.status='pending_payment'
			  AND (? IS NULL OR part.payment_attempt_id=?)
			  AND part.created_at>=? AND part.updated_at<=?
			  AND (part.next_check_at IS NULL OR part.next_check_at<=?)
			 ORDER BY COALESCE(part.next_check_at, 0), part.updated_at, part.id LIMIT ?`,
		)
		.bind(
			scope.attemptId ?? null,
			scope.attemptId ?? null,
			now - reconcileWindowMs,
			now - scope.minIdleMs,
			now,
			scope.limit,
		)
		.all<CheckablePart>();
	let succeeded = 0;
	for (const part of parts.results) {
		try {
			const credential = await loadCredential(db, part.credential_encrypted);
			const query = await getPaymentProvider(part.provider).queryPayment(
				part.provider_payment_id,
				credential,
				fetcher,
			);
			if (query.status === "succeeded") {
				await recordQueriedPayment(db, part, query);
				succeeded += 1;
				continue;
			}
			await db
				.prepare(
					"UPDATE payment_split_parts SET updated_at=?, next_check_at=NULL WHERE id=? AND status='pending'",
				)
				.bind(now, part.id)
				.run();
		} catch (error) {
			await deferPartCheck(db, part.id, now);
			logSplitFailure("split_part_reconcile_failed", part.id, error);
		}
	}
	return { scanned: parts.results.length, succeeded };
}

/**
 * Scheduled every minute after order expiry:
 * 1. completes fully paid plans whose completion was interrupted;
 * 2. checks pending parts with Alipay (missed callbacks);
 * 3. closes unpaid parts of orders that are no longer payable;
 * 4. refunds paid parts of orders that will never be fulfilled;
 * 5. tells the owner about each automatic refund and each refund that needs a human.
 */
export async function settleSplitPayments(
	db: D1Database,
	fetcher: typeof fetch = fetch,
	now = Date.now(),
) {
	const ready = await db
		.prepare(
			`SELECT pa.id FROM payment_attempts pa JOIN shop_orders o ON o.id=pa.order_id
			 WHERE pa.split_part_count IS NOT NULL AND pa.status='pending'
			  AND o.status='pending_payment' AND o.expires_at>? AND pa.created_at>=?
			  AND (SELECT COUNT(*) FROM payment_split_parts part
			   WHERE part.payment_attempt_id=pa.id AND part.status='succeeded') = pa.split_part_count
			 LIMIT 20`,
		)
		.bind(now, now - settleWindowMs)
		.all<{ id: string }>();
	let completed = 0;
	for (const row of ready.results) {
		const result = await completeSplitPaymentIfReady(db, row.id, now).catch(
			(error: unknown) => {
				logSplitFailure("split_completion_failed", row.id, error);
				return null;
			},
		);
		if (result) completed += 1;
	}
	const reconciled = await reconcileSplitParts(db, fetcher, now, {
		minIdleMs: 50_000,
		limit: 20,
	});
	const closed = await closeDeadParts(db, fetcher, now);
	const refunds = await refundUnfulfilledParts(db, fetcher, now);
	const alerts = await alertSplitRefunds(db, fetcher, now);
	return {
		completed,
		reconciled: reconciled.succeeded,
		closed,
		refunded: refunds.succeeded,
		refundFailed: refunds.manual,
		alerts,
	};
}

/** Parts that can no longer be paid for: their order left pending_payment or the plan ended. */
const deadPartCondition = `(o.status<>'pending_payment' OR pa.status IN ('failed','cancelled','expired'))`;

async function closeDeadParts(
	db: D1Database,
	fetcher: typeof fetch,
	now: number,
) {
	await db
		.prepare(
			`UPDATE payment_split_parts SET status='closed', updated_at=?
			 WHERE status IN ('created','failed','expired') AND provider_payment_id IS NULL
			  AND payment_attempt_id IN (SELECT pa.id FROM payment_attempts pa
			   JOIN shop_orders o ON o.id=pa.order_id WHERE ${deadPartCondition})`,
		)
		.bind(now)
		.run();
	const parts = await db
		.prepare(
			`SELECT part.id, part.channel_id, part.provider_payment_id, part.amount_minor,
			 pa.currency, pc.provider, pc.credential_encrypted
			 FROM payment_split_parts part
			 JOIN payment_attempts pa ON pa.id=part.payment_attempt_id
			 JOIN shop_orders o ON o.id=pa.order_id
			 JOIN payment_channels pc ON pc.id=part.channel_id
			 WHERE part.status IN ('pending','expired','failed')
			  AND part.provider_payment_id IS NOT NULL AND ${deadPartCondition}
			  AND part.created_at>=? AND part.updated_at<=?
			  AND (part.next_check_at IS NULL OR part.next_check_at<=?)
			 ORDER BY COALESCE(part.next_check_at, 0), part.updated_at, part.id LIMIT 20`,
		)
		.bind(now - settleWindowMs, now - 50_000, now)
		.all<CheckablePart>();
	let closed = 0;
	for (const part of parts.results) {
		try {
			const credential = await loadCredential(db, part.credential_encrypted);
			const query = await getPaymentProvider(part.provider).queryPayment(
				part.provider_payment_id,
				credential,
				fetcher,
			);
			if (query.status === "succeeded") {
				// Paid at the last moment: recorded as a late payment and refunded below.
				await recordQueriedPayment(db, part, query);
				continue;
			}
			const result =
				query.status === "expired"
					? "closed"
					: await closeAlipayTrade(
							credential,
							part.provider_payment_id,
							fetcher,
						);
			if (result !== "closed") {
				await deferPartCheck(db, part.id, now);
				continue;
			}
			await db
				.prepare(
					`UPDATE payment_split_parts SET status='closed', next_check_at=NULL, updated_at=?
					 WHERE id=? AND status IN ('pending','expired','failed')`,
				)
				.bind(now, part.id)
				.run();
			closed += 1;
		} catch (error) {
			await deferPartCheck(db, part.id, now);
			logSplitFailure("split_part_close_failed", part.id, error);
		}
	}
	return closed;
}

async function refundUnfulfilledParts(
	db: D1Database,
	fetcher: typeof fetch,
	now: number,
) {
	const candidates = await db
		.prepare(
			`SELECT part.id, part.amount_minor, part.refunded_minor
			 FROM payment_split_parts part
			 JOIN payment_attempts pa ON pa.id=part.payment_attempt_id
			 JOIN shop_orders o ON o.id=pa.order_id
			 WHERE part.status='succeeded' AND pa.status<>'succeeded'
			  AND ${deadPartCondition}
			  AND NOT EXISTS (SELECT 1 FROM payment_split_refunds refund
			   WHERE refund.part_id=part.id AND refund.refund_id IS NULL)
			 LIMIT 20`,
		)
		.all<{ id: string; amount_minor: string; refunded_minor: string }>();
	for (const part of candidates.results) {
		const amount = BigInt(part.amount_minor) - BigInt(part.refunded_minor);
		if (amount <= 0n) continue;
		await db
			.prepare(
				`INSERT OR IGNORE INTO payment_split_refunds
				 (id, part_id, refund_id, amount_minor, reason, status, created_at, updated_at)
				 VALUES (?, ?, NULL, ?, 'order_not_paid_in_full', 'pending', ?, ?)`,
			)
			.bind(crypto.randomUUID(), part.id, amount.toString(), now, now)
			.run();
	}
	const rows = await db
		.prepare(
			`SELECT refund.id, refund.attempt_count FROM payment_split_refunds refund
			 WHERE refund.refund_id IS NULL AND refund.status IN ('pending','failed')
			  AND (refund.next_attempt_at IS NULL OR refund.next_attempt_at<=?)
			 ORDER BY refund.created_at, refund.id LIMIT 10`,
		)
		.bind(now)
		.all<{ id: string; attempt_count: number }>();
	let succeeded = 0;
	let manual = 0;
	for (const row of rows.results) {
		const status = await runPartRefund(db, row.id, row.attempt_count, {
			fetcher,
			now,
			reason: "订单未在时限内付完，已付部分原路退回",
			maxAttempts: maxAutomaticRefundAttempts,
		});
		if (status === "succeeded") succeeded += 1;
		if (status === "manual") manual += 1;
	}
	return { succeeded, manual };
}

type PartRefundRow = {
	id: string;
	part_id: string;
	amount_minor: string;
	status: string;
	attempt_count: number;
	provider_payment_id: string;
	provider_trade_no: string | null;
	refunded_minor: string;
	provider: string;
	credential_encrypted: string | null;
};

type PartRefundOutcome = "succeeded" | "uncertain" | "manual" | "skipped";

/**
 * Refunds one part (one payment_split_refunds row). The row id is Alipay's
 * out_request_no, so retrying the same row never refunds twice. The claim is a
 * lease (attempt_count + next_attempt_at); results are written back only for
 * the attempt that holds it, and only a pending/failed → succeeded transition
 * adds to the part's refunded amount. A provider refusal or a response that
 * does not match the request needs a human at once; network and system errors
 * stay "uncertain" and are retried with the same out_request_no.
 */
export async function runPartRefund(
	db: D1Database,
	rowId: string,
	attemptCount: number,
	options: {
		fetcher: typeof fetch;
		now: number;
		reason: string;
		maxAttempts: number;
	},
): Promise<PartRefundOutcome> {
	const attempt = attemptCount + 1;
	const claim = await db
		.prepare(
			`UPDATE payment_split_refunds SET attempt_count=?, next_attempt_at=?, updated_at=?
			 WHERE id=? AND attempt_count=? AND status IN ('pending','failed')
			  AND (next_attempt_at IS NULL OR next_attempt_at<=?)`,
		)
		.bind(
			attempt,
			options.now + refundLeaseMs,
			options.now,
			rowId,
			attemptCount,
			options.now,
		)
		.run();
	if (Number(claim.meta.changes ?? 0) !== 1) return "skipped";
	const row = await db
		.prepare(
			`SELECT refund.id, refund.part_id, refund.amount_minor, refund.status,
			 refund.attempt_count, part.provider_payment_id, part.provider_trade_no,
			 part.refunded_minor, pc.provider, pc.credential_encrypted
			 FROM payment_split_refunds refund
			 JOIN payment_split_parts part ON part.id=refund.part_id
			 JOIN payment_channels pc ON pc.id=part.channel_id
			 WHERE refund.id=? LIMIT 1`,
		)
		.bind(rowId)
		.first<PartRefundRow>();
	if (!row) return "skipped";
	let result: PaymentRefund | null = null;
	let failureCode = "refund_request_failed";
	let reconciliation = false;
	try {
		const credential = await loadCredential(db, row.credential_encrypted);
		result = await getPaymentProvider(row.provider).refundPayment(
			{
				refundId: row.id,
				providerPaymentId: row.provider_payment_id,
				amountMinor: row.amount_minor,
				reason: options.reason,
				expectedRefundedTotalMinor: (
					BigInt(row.refunded_minor) + BigInt(row.amount_minor)
				).toString(),
				providerTradeNo: row.provider_trade_no,
			},
			credential,
			options.fetcher,
		);
	} catch (error) {
		failureCode =
			error instanceof DomainError ? error.code : "refund_request_failed";
		reconciliation =
			error instanceof DomainError &&
			error.code === "payment_refund_reconciliation_required";
	}
	const now = Date.now();
	if (result?.status === "succeeded") {
		const written = await db.batch([
			db
				.prepare(
					`UPDATE payment_split_refunds SET status='succeeded', failure_code=NULL,
					 next_attempt_at=NULL, completed_at=?, updated_at=?
					 WHERE id=? AND attempt_count=? AND status IN ('pending','failed')`,
				)
				.bind(now, now, row.id, attempt),
			db
				.prepare(
					`UPDATE payment_split_parts SET
					 refunded_minor=CAST(CAST(refunded_minor AS INTEGER)+CAST(? AS INTEGER) AS TEXT),
					 updated_at=? WHERE id=? AND changes()=1`,
				)
				.bind(row.amount_minor, now, row.part_id),
			db
				.prepare(
					`INSERT INTO audit_logs (id, action, target_type, target_id, after, created_at)
					 SELECT ?, 'payment.split_refund_succeeded', 'payment_split_part', ?, ?, ?
					 WHERE EXISTS (SELECT 1 FROM payment_split_refunds WHERE id=? AND status='succeeded' AND attempt_count=?)`,
				)
				.bind(
					crypto.randomUUID(),
					row.part_id,
					JSON.stringify({
						refundRowId: row.id,
						amountMinor: row.amount_minor,
					}),
					now,
					row.id,
					attempt,
				),
		]);
		return Number(written[0]?.meta.changes ?? 0) === 1
			? "succeeded"
			: "skipped";
	}
	if (result) failureCode = result.failureCode ?? result.status;
	const retryable =
		!reconciliation &&
		(result === null ||
			result.status === "pending" ||
			retryableRefundCodes.has(failureCode));
	const manual = !retryable || attempt >= options.maxAttempts;
	const written = await db.batch([
		db
			.prepare(
				`UPDATE payment_split_refunds SET status=?, failure_code=?, next_attempt_at=?,
				 updated_at=? WHERE id=? AND attempt_count=? AND status IN ('pending','failed')`,
			)
			.bind(
				manual ? "manual" : "failed",
				failureCode.slice(0, 120),
				manual ? null : now + 300_000,
				now,
				row.id,
				attempt,
			),
		db
			.prepare(
				`INSERT INTO audit_logs (id, action, target_type, target_id, after, created_at)
				 SELECT ?, 'payment.split_refund_failed', 'payment_split_part', ?, ?, ?
				 WHERE changes()=1`,
			)
			.bind(
				crypto.randomUUID(),
				row.part_id,
				JSON.stringify({
					refundRowId: row.id,
					amountMinor: row.amount_minor,
					failureCode,
					manual,
				}),
				now,
			),
	]);
	if (Number(written[0]?.meta.changes ?? 0) !== 1) return "skipped";
	return manual ? "manual" : "uncertain";
}

async function alertSplitRefunds(
	db: D1Database,
	fetcher: typeof fetch,
	now: number,
) {
	const rows = await db
		.prepare(
			`SELECT refund.id, refund.status, refund.amount_minor, refund.failure_code,
			 part.part_index, part.part_count, part.provider_payment_id,
			 o.order_number, o.status AS order_status
			 FROM payment_split_refunds refund
			 JOIN payment_split_parts part ON part.id=refund.part_id
			 JOIN payment_attempts pa ON pa.id=part.payment_attempt_id
			 JOIN shop_orders o ON o.id=pa.order_id
			 WHERE refund.refund_id IS NULL AND refund.alerted_at IS NULL
			  AND refund.status IN ('succeeded','manual')
			 ORDER BY refund.updated_at, refund.id LIMIT 10`,
		)
		.all<{
			id: string;
			status: string;
			amount_minor: string;
			failure_code: string | null;
			part_index: number;
			part_count: number;
			provider_payment_id: string;
			order_number: string;
			order_status: string;
		}>();
	let sent = 0;
	for (const row of rows.results) {
		const amount = `¥${minorToDecimal(row.amount_minor, 2)}`;
		const part = `第 ${row.part_index}/${row.part_count} 笔`;
		const text =
			row.status === "succeeded"
				? `【拆单付款已自动退款】订单 ${row.order_number} 没在时限内付完（订单状态 ${row.order_status}），已把${part} ${amount} 原路退回支付宝。没有发货。\n支付宝商户订单号：${row.provider_payment_id}`
				: `【拆单退款失败·需人工处理】订单 ${row.order_number} 没在时限内付完，${part} ${amount} 自动原路退款失败（${row.failure_code ?? "unknown"}）。没有发货。请到支付宝商家后台按商户订单号 ${row.provider_payment_id} 手动退款，退完在后台「支付渠道 → 拆单退款待人工处理」点「已人工退款」填支付宝退款单号结案。`;
		let delivered = false;
		try {
			delivered = Boolean(
				await sendOwnerAlert(db, text, { topic: "orders", fetcher }),
			);
		} catch {
			delivered = false;
		}
		if (!delivered) continue;
		await db
			.prepare(
				"UPDATE payment_split_refunds SET alerted_at=?, updated_at=? WHERE id=?",
			)
			.bind(now, now, row.id)
			.run();
		sent += 1;
	}
	return sent;
}

/**
 * Admin refund of a paid split order: the refund is spread over the paid parts
 * (latest part first) and each share is refunded on its own Alipay trade.
 * Returns null when the refund's payment is not a split payment.
 *
 * - every share refunded → succeeded;
 * - any share uncertain (network/system error) → pending: the parent refund
 *   stays processing and the order refunding; retried with the same ids;
 * - any share whose answer did not match (money may have moved) or some
 *   shares refunded and others refused → throws
 *   `payment_refund_reconciliation_required` (manual confirmation); never
 *   reported as "not refunded", so the order is never restored to paid;
 * - nothing refunded and every share definitely refused → failed.
 */
export async function refundSplitPayment(
	db: D1Database,
	refund: {
		id: string;
		payment_attempt_id: string | null;
		payment_amount_minor: string;
		reason: string;
	},
	fetcher: typeof fetch = fetch,
): Promise<PaymentRefund | null> {
	if (!refund.payment_attempt_id) return null;
	const parent = await db
		.prepare(
			"SELECT split_part_count FROM payment_attempts WHERE id=? AND split_part_count IS NOT NULL",
		)
		.bind(refund.payment_attempt_id)
		.first<{ split_part_count: number }>();
	if (!parent) return null;
	const providerRefundId = `split:${refund.id}`;
	const existing = await db
		.prepare(
			"SELECT COUNT(*) AS count FROM payment_split_refunds WHERE refund_id=?",
		)
		.bind(refund.id)
		.first<{ count: number }>();
	if (!Number(existing?.count ?? 0)) {
		const parts = await db
			.prepare(
				`SELECT part.id, part.amount_minor, part.refunded_minor,
				 COALESCE((SELECT SUM(CAST(other.amount_minor AS INTEGER)) FROM payment_split_refunds other
				  WHERE other.part_id=part.id AND other.status IN ('pending','failed','manual')),0) AS reserved
				 FROM payment_split_parts part
				 WHERE part.payment_attempt_id=? AND part.status='succeeded'
				 ORDER BY part.part_index DESC`,
			)
			.bind(refund.payment_attempt_id)
			.all<{
				id: string;
				amount_minor: string;
				refunded_minor: string;
				reserved: number | string;
			}>();
		let remaining = BigInt(refund.payment_amount_minor);
		const allocations: Array<{ partId: string; amount: bigint }> = [];
		for (const part of parts.results) {
			if (remaining === 0n) break;
			const available =
				BigInt(part.amount_minor) -
				BigInt(part.refunded_minor) -
				BigInt(String(part.reserved));
			if (available <= 0n) continue;
			const amount = available < remaining ? available : remaining;
			allocations.push({ partId: part.id, amount });
			remaining -= amount;
		}
		if (remaining > 0n)
			return {
				providerRefundId,
				status: "failed",
				failureCode: "split_refund_exceeds_parts",
			};
		const now = Date.now();
		await db.batch(
			allocations.map((allocation) =>
				db
					.prepare(
						`INSERT OR IGNORE INTO payment_split_refunds
						 (id, part_id, refund_id, amount_minor, reason, status, created_at, updated_at)
						 VALUES (?, ?, ?, ?, 'admin_refund', 'pending', ?, ?)`,
					)
					.bind(
						crypto.randomUUID(),
						allocation.partId,
						refund.id,
						allocation.amount.toString(),
						now,
						now,
					),
			),
		);
	}
	const load = () =>
		db
			.prepare(
				`SELECT refund.id, refund.status, refund.attempt_count, refund.failure_code
				 FROM payment_split_refunds refund
				 JOIN payment_split_parts part ON part.id=refund.part_id
				 WHERE refund.refund_id=? ORDER BY part.part_index DESC`,
			)
			.bind(refund.id)
			.all<{
				id: string;
				status: string;
				attempt_count: number;
				failure_code: string | null;
			}>();
	const rows = await load();
	const anySucceeded = rows.results.some((row) => row.status === "succeeded");
	const anyUnexplained = rows.results.some(unexplainedRefund);
	for (const row of rows.results) {
		if (row.status === "succeeded") continue;
		if (row.status === "manual" && !anySucceeded && !anyUnexplained)
			// An admin retry of a refund that moved no money: try the refused shares again.
			await db
				.prepare(
					"UPDATE payment_split_refunds SET status='failed', next_attempt_at=NULL, updated_at=? WHERE id=? AND status='manual'",
				)
				.bind(Date.now(), row.id)
				.run();
		if (row.status === "manual" && (anySucceeded || anyUnexplained)) continue;
		await runPartRefund(db, row.id, row.attempt_count, {
			fetcher,
			now: Date.now(),
			reason: refund.reason,
			maxAttempts: Number.MAX_SAFE_INTEGER,
		});
	}
	const after = (await load()).results;
	const succeeded = after.filter((row) => row.status === "succeeded").length;
	if (succeeded === after.length)
		return { providerRefundId, status: "succeeded", failureCode: null };
	const uncertain = after.some((row) =>
		["pending", "failed"].includes(row.status),
	);
	if (uncertain)
		return {
			providerRefundId,
			status: "pending",
			failureCode: "split_refund_in_progress",
		};
	if (succeeded === 0 && !after.some(unexplainedRefund))
		return {
			providerRefundId,
			status: "failed",
			failureCode:
				after.find((row) => row.failure_code)?.failure_code ??
				"split_refund_failed",
		};
	throw new DomainError(
		"payment_refund_reconciliation_required",
		409,
		"Part of the split refund was refused; confirm the rest manually",
	);
}

/** A share whose Alipay answer did not match the request: money may have moved. */
function unexplainedRefund(row: {
	status: string;
	failure_code: string | null;
}) {
	return (
		row.status === "manual" &&
		row.failure_code === "payment_refund_reconciliation_required"
	);
}

/**
 * Closes split refund shares that were refunded by hand in the Alipay merchant
 * console. `refundRowIds` limits it to given rows; `refundId` to one admin refund.
 * Each share moves to succeeded once and adds to its part's refunded amount.
 */
export async function completeSplitRefundsManually(
	db: D1Database,
	input: {
		rowIds?: string[];
		refundId?: string;
		reference: string;
		actorUserId: string;
	},
) {
	const reference = input.reference.trim();
	if (!reference || reference.length > 200)
		throw new DomainError(
			"refund_reference_invalid",
			400,
			"External refund reference is required",
		);
	const rows = await db
		.prepare(
			`SELECT id, part_id, amount_minor FROM payment_split_refunds
			 WHERE status IN ('pending','failed','manual')
			  AND (? IS NULL OR refund_id = ?)
			  AND (? IS NULL OR id IN (SELECT value FROM json_each(?)))`,
		)
		.bind(
			input.refundId ?? null,
			input.refundId ?? null,
			input.rowIds ? "rows" : null,
			JSON.stringify(input.rowIds ?? []),
		)
		.all<{ id: string; part_id: string; amount_minor: string }>();
	const now = Date.now();
	let completed = 0;
	for (const row of rows.results) {
		const results = await db.batch([
			db
				.prepare(
					`UPDATE payment_split_refunds SET status='succeeded', failure_code=NULL,
					 next_attempt_at=NULL, completed_at=?, manual_reference=?, completed_by=?,
					 updated_at=? WHERE id=? AND status IN ('pending','failed','manual')`,
				)
				.bind(now, reference, input.actorUserId, now, row.id),
			db
				.prepare(
					`UPDATE payment_split_parts SET
					 refunded_minor=CAST(CAST(refunded_minor AS INTEGER)+CAST(? AS INTEGER) AS TEXT),
					 updated_at=? WHERE id=? AND changes()=1`,
				)
				.bind(row.amount_minor, now, row.part_id),
			db
				.prepare(
					`INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, after, created_at)
					 SELECT ?, ?, 'payment.split_refund_manually_completed', 'payment_split_part', ?, ?, ?
					 WHERE EXISTS (SELECT 1 FROM payment_split_refunds WHERE id=? AND status='succeeded' AND completed_at=?)`,
				)
				.bind(
					crypto.randomUUID(),
					input.actorUserId,
					row.part_id,
					JSON.stringify({
						refundRowId: row.id,
						amountMinor: row.amount_minor,
						reference,
					}),
					now,
					row.id,
					now,
				),
		]);
		completed += Number(results[0]?.meta.changes ?? 0);
	}
	return { completed };
}

/** Split refund shares waiting for a human (admin list). */
export async function listManualSplitRefunds(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT refund.id, refund.amount_minor, refund.status, refund.failure_code,
			 refund.reason, refund.created_at, part.part_index, part.part_count,
			 part.provider_payment_id, o.order_number
			 FROM payment_split_refunds refund
			 JOIN payment_split_parts part ON part.id=refund.part_id
			 JOIN payment_attempts pa ON pa.id=part.payment_attempt_id
			 JOIN shop_orders o ON o.id=pa.order_id
			 WHERE refund.status='manual' AND refund.refund_id IS NULL
			 ORDER BY refund.created_at, refund.id LIMIT 100`,
		)
		.all<{
			id: string;
			amount_minor: string;
			status: string;
			failure_code: string | null;
			reason: string;
			created_at: number;
			part_index: number;
			part_count: number;
			provider_payment_id: string;
			order_number: string;
		}>();
	return rows.results.map((row) => ({
		id: row.id,
		amountMinor: row.amount_minor,
		failureCode: row.failure_code,
		createdAt: Number(row.created_at),
		partIndex: Number(row.part_index),
		partCount: Number(row.part_count),
		merchantTradeNo: row.provider_payment_id,
		orderNumber: row.order_number,
	}));
}
