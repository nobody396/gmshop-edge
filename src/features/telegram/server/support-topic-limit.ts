import { claimFixedWindowRateLimit } from "#/server/rate-limit";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;

export const supportTopicLimits = {
	globalShort: { limit: 20, windowMs: 10 * minuteMs },
	globalHour: { limit: 60, windowMs: hourMs },
	userHour: { limit: 3, windowMs: hourMs },
} as const;

export type SupportTopicLimitCode =
	| "support_topic_user_limited"
	| "support_topic_global_limited";

/**
 * Claims one NEW support-topic slot. Call only when a brand-new forum topic is
 * about to be created; continuing an open conversation must never call this.
 * The per-user bucket is checked first so one stranger cannot burn the global
 * budget with repeated attempts.
 */
export async function claimSupportTopicSlot(
	db: D1Database,
	userKey: string,
): Promise<
	{ allowed: true } | { allowed: false; code: SupportTopicLimitCode }
> {
	const user = await claimFixedWindowRateLimit(db, {
		bucketKey: `support:topic-open:user:${userKey}`,
		...supportTopicLimits.userHour,
	});
	if (!user.allowed)
		return { allowed: false, code: "support_topic_user_limited" };
	for (const [name, rule] of [
		["10m", supportTopicLimits.globalShort],
		["1h", supportTopicLimits.globalHour],
	] as const) {
		const global = await claimFixedWindowRateLimit(db, {
			bucketKey: `support:topic-open:global:${name}`,
			...rule,
		});
		if (!global.allowed)
			return { allowed: false, code: "support_topic_global_limited" };
	}
	return { allowed: true };
}

export function logSupportTopicLimited(code: SupportTopicLimitCode) {
	console.warn(JSON.stringify({ event: code }));
}
