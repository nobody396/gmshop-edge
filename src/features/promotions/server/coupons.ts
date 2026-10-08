import { DomainError } from "#/lib/domain-error";

export type PromotionCoupon = {
	id: string;
	purpose: "standard" | "referral" | "recall";
	referrer_user_id: string | null;
	recipient_user_id: string | null;
};

export async function assertPromotionOwner(
	db: D1Database,
	coupon: PromotionCoupon,
	buyer: { userId?: string; normalizedEmail: string | null },
) {
	if (coupon.purpose === "standard") return;
	if (coupon.purpose === "recall") {
		const user =
			buyer.userId &&
			(await db
				.prepare(
					"SELECT id FROM users WHERE id = ? AND enabled = 1 AND email_verified = 1",
				)
				.bind(buyer.userId)
				.first());
		if (!user || coupon.recipient_user_id !== buyer.userId)
			throw new DomainError(
				"coupon_recipient_required",
				403,
				"Sign in to the account that owns this coupon",
			);
	} else {
		const owner = await db
			.prepare("SELECT id, email FROM users WHERE id = ? AND enabled = 1")
			.bind(coupon.referrer_user_id)
			.first<{ id: string; email: string }>();
		if (!owner)
			throw new DomainError("coupon_unavailable", 409, "Coupon is unavailable");
		if (
			owner.id === buyer.userId ||
			owner.email.toLowerCase() === buyer.normalizedEmail?.toLowerCase()
		)
			throw new DomainError(
				"coupon_self_referral",
				409,
				"Your own invitation code cannot be used for this order",
			);
	}
}

export async function openReferralCoupon(db: D1Database, userId: string) {
	const now = Date.now();
	const code = `INV-${crypto.randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
	await db
		.prepare(`INSERT INTO coupons (id, code, name, type, currency, currency_decimals, value_minor,
  enabled, purpose, referrer_user_id, created_at, updated_at)
  SELECT ?, ?, 'Invitation', 'fixed', 'CNY', 2, '400', 1, 'referral', id, ?, ? FROM users WHERE id = ? AND enabled = 1
  ON CONFLICT(referrer_user_id) WHERE purpose = 'referral' DO NOTHING`)
		.bind(crypto.randomUUID(), code, now, now, userId)
		.run();
	const row = await db
		.prepare(
			"SELECT code, enabled FROM coupons WHERE purpose = 'referral' AND referrer_user_id = ?",
		)
		.bind(userId)
		.first<{ code: string; enabled: number }>();
	if (!row)
		throw new DomainError("authentication_required", 401, "Sign in required");
	return row;
}

export async function issueRecallCoupon(
	db: D1Database,
	input: {
		userId: string;
		campaignKey: string;
		startsAt: number;
	},
) {
	const user = await db
		.prepare(`SELECT id FROM users WHERE id = ? AND enabled = 1 AND email_verified = 1
  AND marketing_consent = 1 AND EXISTS (SELECT 1 FROM shop_orders WHERE user_id = users.id AND paid_at IS NOT NULL
   AND status IN ('paid','fulfilling','completed'))`)
		.bind(input.userId)
		.first();
	if (!user)
		throw new DomainError(
			"recall_customer_ineligible",
			409,
			"Customer is not eligible for a personal recall coupon",
		);
	const now = Date.now();
	const code = `BACK-${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
	await db
		.prepare(`INSERT INTO coupons (id, code, name, type, currency, currency_decimals, value_minor,
  enabled, purpose, recipient_user_id, campaign_key, usage_limit, usage_limit_per_customer, starts_at, ends_at, created_at, updated_at)
  VALUES (?, ?, 'Personal recall', 'fixed', 'CNY', 2, '800', 1, 'recall', ?, ?, 1, 1, ?, ?, ?, ?)
  ON CONFLICT(campaign_key,recipient_user_id) WHERE purpose = 'recall' DO NOTHING`)
		.bind(
			crypto.randomUUID(),
			code,
			input.userId,
			input.campaignKey,
			input.startsAt,
			input.startsAt + 7 * 86400000,
			now,
			now,
		)
		.run();
	return db
		.prepare(`SELECT id,code,starts_at,ends_at,used_count,enabled FROM coupons
  WHERE purpose = 'recall' AND campaign_key = ? AND recipient_user_id = ?`)
		.bind(input.campaignKey, input.userId)
		.first<{
			id: string;
			code: string;
			starts_at: number;
			ends_at: number;
			used_count: number;
			enabled: number;
		}>();
}
