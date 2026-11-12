/**
 * Identity and payment-history checks shared by the scheduler (before claiming)
 * and the send-time guard (right before the provider). Kept free of the
 * notification delivery module so the delivery path can import it.
 */

/**
 * Staff/owner (any role other than customer/guest — the renewal rule) or agent
 * (agent-access buyer, supplier API key holder, API allowlist), matched by the
 * order's account OR by any account whose email is the order email. Every
 * predicate is index-backed (users_lower_email_idx, agent_access_orders_*_idx,
 * supplier_api_keys_user_active_idx, supplier_api_allowed_users PK).
 */
export async function identityExclusion(
	db: D1Database,
	userId: string | null,
	email: string,
): Promise<"staff" | "agent" | null> {
	const row = await db
		.prepare(
			`WITH identity AS (
			  SELECT id, role_ids FROM users WHERE id = ?
			  UNION SELECT id, role_ids FROM users WHERE lower(email) = ?
			 )
			 SELECT
			  EXISTS (SELECT 1 FROM identity i, json_each(i.role_ids) assigned
			   JOIN roles r ON r.id = assigned.value
			   WHERE r.name NOT IN ('customer','guest')) AS staff,
			  (EXISTS (SELECT 1 FROM identity i JOIN supplier_api_keys k ON k.user_id = i.id)
			   OR EXISTS (SELECT 1 FROM identity i JOIN supplier_api_allowed_users au ON au.user_id = i.id)
			   OR EXISTS (SELECT 1 FROM identity i JOIN agent_access_orders aa ON aa.user_id = i.id)
			   OR EXISTS (SELECT 1 FROM agent_access_orders aa WHERE lower(trim(aa.email)) = ?)
			  ) AS agent`,
		)
		.bind(userId, email, email)
		.first<{ staff: number; agent: number }>();
	if (row?.staff) return "staff";
	if (row?.agent) return "agent";
	return null;
}

/** Any other paid order by the same email or account, split at `since`. */
export async function paymentHistory(
	db: D1Database,
	order: { id: string; userId: string | null; email: string },
	since: number,
) {
	const row = await db
		.prepare(
			`SELECT MAX(paid_at >= ?) AS paid_later, MAX(paid_at < ?) AS paid_before FROM (
			 SELECT paid_at FROM shop_orders WHERE normalized_contact_email = ?
			  AND id <> ? AND paid_at IS NOT NULL
			 UNION ALL
			 SELECT paid_at FROM shop_orders WHERE user_id = ?
			  AND id <> ? AND paid_at IS NOT NULL)`,
		)
		.bind(since, since, order.email, order.id, order.userId, order.id)
		.first<{ paid_later: number | null; paid_before: number | null }>();
	return {
		paidLater: Boolean(row?.paid_later),
		paidBefore: Boolean(row?.paid_before),
	};
}

/** Address left behind by customer data deletion (privacy.ts anonymization). */
export function isDeletedCustomerEmail(email: string) {
	return email.trim().toLowerCase().endsWith("@invalid.gmshop");
}

/** Opted out of any of our marketing-type emails (every scope counts). */
export async function isUnsubscribed(db: D1Database, hash: string) {
	const row = await db
		.prepare(
			"SELECT 1 AS found FROM email_unsubscribes WHERE recipient_hash = ? LIMIT 1",
		)
		.bind(hash)
		.first<{ found: number }>();
	return Boolean(row);
}

/** SQL flag: the order took any money (attempt or split part). */
export const orderAnyPaymentSql = (alias: string) => `(EXISTS (SELECT 1 FROM
 payment_attempts pa WHERE pa.order_id = ${alias}.id AND pa.status = 'succeeded')
 OR EXISTS (SELECT 1 FROM payment_split_parts sp JOIN payment_attempts pa
  ON pa.id = sp.payment_attempt_id WHERE pa.order_id = ${alias}.id AND sp.status = 'succeeded'))`;
