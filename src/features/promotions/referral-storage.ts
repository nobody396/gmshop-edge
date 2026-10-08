const key = "gmshop-referral";
const ttl = 30 * 86400000;
export function captureReferral(code: string, now = Date.now()) {
	if (!/^INV-[A-Z0-9]{20}$/.test(code.toUpperCase())) return;
	try {
		localStorage.setItem(
			key,
			JSON.stringify({ code: code.toUpperCase(), expiresAt: now + ttl }),
		);
	} catch {
		/* Storage is optional; manual codes still work. */
	}
}
export function readReferral(now = Date.now()) {
	try {
		const value = JSON.parse(localStorage.getItem(key) ?? "null");
		if (
			value &&
			typeof value.code === "string" &&
			/^INV-[A-Z0-9]{20}$/.test(value.code) &&
			typeof value.expiresAt === "number" &&
			value.expiresAt > now
		)
			return value.code as string;
		localStorage.removeItem(key);
	} catch {
		/* Private browsing may deny storage. */
	}
	return "";
}
