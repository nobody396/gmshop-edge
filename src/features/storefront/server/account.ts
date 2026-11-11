import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { getAuth } from "#/features/auth/server/auth";
import {
	deviceIdFromRequest,
	recordUserDevice,
} from "#/features/promotions/device";
import { DomainError } from "#/lib/domain-error";

export type StoreSessionUser = {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
	enabled: boolean;
	preferredLocale: "en-US" | "zh-CN";
};

export async function getStoreSessionUser(request: Request) {
	const session = await getStoreSession(request);
	return session?.user ?? null;
}

export async function getStoreSession(request: Request) {
	const session = await (await getAuth(request)).api.getSession({
		headers: request.headers,
	});
	if (!session?.user) return null;
	const user = session.user as StoreSessionUser;
	if (user.enabled !== true)
		throw new DomainError("account_disabled", 403, "Account is disabled");
	return { session: session.session, user };
}

export async function resolveStoreAccount(
	db: D1Database,
	request: Request,
	options: { required?: boolean } = {},
) {
	const session = await getStoreSession(request);
	if (!session) {
		if (options.required)
			throw new DomainError("authentication_required", 401, "Sign in required");
		return null;
	}
	const { user } = session;
	const deviceId = deviceIdFromRequest(request);
	if (deviceId) await recordUserDevice(db, user.id, deviceId);
	const normalizedEmail = user.email.trim().toLowerCase();
	if (user.emailVerified && !isInternalIdentityEmail(normalizedEmail))
		await claimGuestCommerceHistory(db, user.id, normalizedEmail);
	return { user };
}

async function claimGuestCommerceHistory(
	db: D1Database,
	userId: string,
	normalizedEmail: string,
) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`UPDATE shop_orders SET user_id = ?, updated_at = ?
				 WHERE user_id IS NULL AND normalized_contact_email = ?`,
			)
			.bind(userId, now, normalizedEmail),
		db
			.prepare(
				`UPDATE customer_entitlements SET user_id = ?, updated_at = ?
				 WHERE user_id IS NULL AND EXISTS (
				  SELECT 1 FROM shop_order_items item
				  JOIN shop_orders orders ON orders.id = item.order_id
				  WHERE item.id = customer_entitlements.order_item_id
				   AND orders.user_id = ?
				 )`,
			)
			.bind(userId, now, userId),
		db
			.prepare(
				`UPDATE coupon_redemptions SET user_id = ?, updated_at = ?
				 WHERE user_id IS NULL AND normalized_email = ?`,
			)
			.bind(userId, now, normalizedEmail),
	]);
}
