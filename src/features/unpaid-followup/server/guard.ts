import {
	recipientHash,
	recipientSuppressionReason,
} from "#/features/notifications/server/recipient-policy";
import {
	identityExclusion,
	isUnsubscribed,
	orderAnyPaymentSql,
	paymentHistory,
} from "./eligibility";
import { loadUnpaidFollowupSettings } from "./settings";

export const unpaidFollowupEmailEvent = "unpaid_order_followup";
export const unpaidFollowupKeyPrefix = "unpaid_followup:";
/** A queued follow-up this long after the order expired is no longer "just now". */
export const unpaidFollowupStaleAfterMs = 3 * 3_600_000;

export function followupIdempotencyKey(orderId: string) {
	return `${unpaidFollowupKeyPrefix}${orderId}`;
}

/**
 * Send-time re-check, run by the delivery path immediately before the provider
 * (and again on every retry). Returns why the queued email must not go out, or
 * null when it still may. Read-only.
 */
export async function unpaidFollowupStopReason(
	db: D1Database,
	orderId: string,
	now: number,
) {
	const row = await db
		.prepare(
			`SELECT f.status, f.activation_at, o.status AS order_status, o.paid_at,
			 o.paid_minor, o.user_id, o.normalized_contact_email AS email,
			 o.created_at, o.expires_at, ${orderAnyPaymentSql("o")} AS any_payment
			 FROM unpaid_order_followups f JOIN shop_orders o ON o.id = f.order_id
			 WHERE f.order_id = ? LIMIT 1`,
		)
		.bind(orderId)
		.first<{
			status: string;
			activation_at: number | null;
			order_status: string;
			paid_at: number | null;
			paid_minor: string;
			user_id: string | null;
			email: string | null;
			created_at: number;
			expires_at: number;
			any_payment: number;
		}>();
	if (!row || (row.status !== "sending" && row.status !== "sent"))
		return "not_claimed";
	const settings = await loadUnpaidFollowupSettings(db);
	if (
		!settings.enabled ||
		row.activation_at === null ||
		settings.activatedAt !== row.activation_at
	)
		return "disabled";
	if (
		row.order_status !== "expired" ||
		row.paid_at !== null ||
		row.paid_minor !== "0" ||
		row.any_payment
	)
		return "paid";
	if (now > row.expires_at + unpaidFollowupStaleAfterMs) return "stale";
	const email = row.email?.trim().toLowerCase();
	if (!email) return "no_email";
	const identity = await identityExclusion(db, row.user_id, email);
	if (identity) return identity;
	const history = await paymentHistory(
		db,
		{ id: orderId, userId: row.user_id, email },
		row.created_at,
	);
	if (history.paidLater) return "paid_later";
	if (history.paidBefore) return "existing_customer";
	if (await isUnsubscribed(db, await recipientHash(email)))
		return "unsubscribed";
	if (await recipientSuppressionReason(db, email, unpaidFollowupEmailEvent))
		return "suppressed";
	return null;
}
