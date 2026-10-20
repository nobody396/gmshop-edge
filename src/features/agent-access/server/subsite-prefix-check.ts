import { DomainError } from "#/lib/domain-error";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import { checkSubsitePrefix } from "./checkout";
import { requireAgentAccessEnabled } from "./client";

// Server-only: kept out of functions.ts, whose plain exports ship to the
// browser bundle (only Server Function handlers are stripped there).
export const subsitePrefixCheckLimit = { limit: 20, windowMs: 60_000 };
// Signed-in, verified buyers only; each call is one signed lsrai.shop request.
export async function checkSubsitePrefixForBuyer(
	db: D1Database,
	userId: string,
	prefix: string,
	check: typeof checkSubsitePrefix = checkSubsitePrefix,
) {
	await requireAgentAccessEnabled(db);
	const quota = await claimFixedWindowRateLimit(db, {
		bucketKey: `agent-subsite-prefix:${userId}`,
		...subsitePrefixCheckLimit,
	});
	if (!quota.allowed)
		throw new DomainError(
			"agent_subsite_prefix_rate_limited",
			429,
			"Too many sub-site name checks; wait a minute",
		);
	return check(prefix);
}
