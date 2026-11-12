import { z } from "zod";
import { firstTouchCookieName, lastTouchCookieName } from "../first-touch";
import { classifySource, inAppBrowsers } from "../sources";

const touchSchema = z.object({
	v: z.literal(1),
	r: z.string().max(253).optional(),
	s: z.string().max(100).optional(),
	m: z.string().max(100).optional(),
	c: z.string().max(150).optional(),
	p: z.string().max(200).default("/"),
	t: z.number().int().positive().optional(),
	// Unknown values (a future browser) are dropped rather than voiding the touch.
	i: z.enum(inAppBrowsers).optional().catch(undefined),
	f: z.literal(1).optional().catch(undefined),
});
type ParsedTouch = z.infer<typeof touchSchema>;

function parseTouchCookie(cookieHeader: string | null, name: string) {
	const raw = cookieHeader
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${name}=`))
		?.slice(name.length + 1);
	if (!raw || raw.length > 2_000) return null;
	try {
		const parsed = touchSchema.safeParse(JSON.parse(decodeURIComponent(raw)));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function parseFirstTouchCookie(cookieHeader: string | null) {
	return parseTouchCookie(cookieHeader, firstTouchCookieName);
}

export function parseLastTouchCookie(cookieHeader: string | null) {
	return parseTouchCookie(cookieHeader, lastTouchCookieName);
}

function categoryOf(touch: ParsedTouch) {
	return classifySource({
		referrerHost: touch.r,
		utmSource: touch.s,
		utmMedium: touch.m,
		invite: touch.f === 1,
		inApp: touch.i,
	});
}

function seenAt(touch: ParsedTouch, now: number) {
	return touch.t && touch.t <= now ? touch.t : null;
}

/**
 * Attaches the visitor's first-touch source and latest non-direct touch to a
 * newly created order. Orders placed without the first-touch cookie (scripts
 * disabled, API clients) stay unattributed; without a last-touch cookie the
 * last_* columns stay NULL and reports fall back to the first touch. Failures
 * never block checkout.
 */
export async function recordOrderAttribution(
	db: D1Database,
	orderId: string,
	request: Request,
) {
	try {
		const cookies = request.headers.get("cookie");
		const touch = parseFirstTouchCookie(cookies);
		const last = parseLastTouchCookie(cookies);
		const now = Date.now();
		await db
			.prepare(
				`INSERT OR IGNORE INTO order_attribution
				 (order_id, source_category, referrer_host, utm_source, utm_medium,
				  utm_campaign, landing_path, first_seen_at, in_app_browser,
				  last_source_category, last_referrer_host, last_utm_source,
				  last_utm_medium, last_utm_campaign, last_landing_path,
				  last_seen_at, last_in_app_browser, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				orderId,
				touch ? categoryOf(touch) : "unknown",
				touch?.r ?? null,
				touch?.s ?? null,
				touch?.m ?? null,
				touch?.c ?? null,
				touch?.p ?? null,
				touch ? seenAt(touch, now) : null,
				touch?.i ?? null,
				last ? categoryOf(last) : null,
				last?.r ?? null,
				last?.s ?? null,
				last?.m ?? null,
				last?.c ?? null,
				last?.p ?? null,
				last ? seenAt(last, now) : null,
				last?.i ?? null,
				now,
			)
			.run();
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "order_attribution_failed",
				errorType: error instanceof Error ? error.name : typeof error,
			}),
		);
	}
}
