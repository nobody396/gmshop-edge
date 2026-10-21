import { z } from "zod";
import { firstTouchCookieName } from "../first-touch";
import { classifySource } from "../sources";

const firstTouchSchema = z.object({
	v: z.literal(1),
	r: z.string().max(253).optional(),
	s: z.string().max(100).optional(),
	m: z.string().max(100).optional(),
	c: z.string().max(150).optional(),
	p: z.string().max(200).default("/"),
	t: z.number().int().positive().optional(),
});

export function parseFirstTouchCookie(cookieHeader: string | null) {
	const raw = cookieHeader
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${firstTouchCookieName}=`))
		?.slice(firstTouchCookieName.length + 1);
	if (!raw || raw.length > 2_000) return null;
	try {
		const parsed = firstTouchSchema.safeParse(
			JSON.parse(decodeURIComponent(raw)),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Attaches the visitor's first-touch source to a newly created order.
 * Orders placed without the cookie (scripts disabled, API clients) stay
 * unattributed; failures never block checkout.
 */
export async function recordOrderAttribution(
	db: D1Database,
	orderId: string,
	request: Request,
) {
	try {
		const touch = parseFirstTouchCookie(request.headers.get("cookie"));
		const now = Date.now();
		await db
			.prepare(
				`INSERT OR IGNORE INTO order_attribution
				 (order_id, source_category, referrer_host, utm_source, utm_medium,
				  utm_campaign, landing_path, first_seen_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				orderId,
				touch
					? classifySource({ referrerHost: touch.r, utmSource: touch.s })
					: "unknown",
				touch?.r ?? null,
				touch?.s ?? null,
				touch?.m ?? null,
				touch?.c ?? null,
				touch?.p ?? null,
				touch?.t && touch.t <= now ? touch.t : null,
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
