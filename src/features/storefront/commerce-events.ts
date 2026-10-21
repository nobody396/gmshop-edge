import { trackCommerceEventFn } from "#/features/storefront/server/functions";

const SESSION_KEY = "gmshop-commerce-session";

export function commerceSessionId() {
	if (typeof window === "undefined") return null;
	let value = window.sessionStorage.getItem(SESSION_KEY);
	if (!value) {
		value = randomSessionId();
		window.sessionStorage.setItem(SESSION_KEY, value);
	}
	return value;
}

// crypto.randomUUID only exists in secure contexts; a page opened over plain
// http (e.g. a bare domain tapped in WeChat) must still render.
export function randomSessionId() {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export function trackCommerceEvent(input: {
	eventType:
		| "catalog_viewed"
		| "product_viewed"
		| "cart_item_added"
		| "checkout_started"
		| "cross_sell_landed"
		| "redeem_landed";
	productId?: string;
	sellableItemId?: string;
}) {
	const sessionId = commerceSessionId();
	if (!sessionId) return;
	void trackCommerceEventFn({
		data: {
			...input,
			sessionId,
			productId: input.productId ?? null,
			sellableItemId: input.sellableItemId ?? null,
		},
	}).catch(() => undefined);
}
