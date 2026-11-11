/** First-party browser tag used to tell a referrer's own browser from a friend's. */
export const deviceCookieName = "gm_device";
const devicePattern = /^[a-f0-9]{32}$/;

export function isDeviceId(value: string | null | undefined): value is string {
	return typeof value === "string" && devicePattern.test(value);
}

/** Reads the device tag from a request's Cookie header. */
export function deviceIdFromRequest(request: Request): string | null {
	const header = request.headers.get("cookie") ?? "";
	for (const part of header.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === deviceCookieName) {
			const value = rest.join("=");
			return isDeviceId(value) ? value : null;
		}
	}
	return null;
}

/** Remembers that a signed-in account used this browser; at most one write per day per pair. */
export function recordUserDevice(
	db: D1Database,
	userId: string,
	deviceId: string,
	now = Date.now(),
) {
	return db
		.prepare(
			`INSERT INTO user_devices(user_id, device_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(user_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
			 WHERE user_devices.last_seen_at < excluded.last_seen_at - 86400000`,
		)
		.bind(userId, deviceId, now, now)
		.run();
}
