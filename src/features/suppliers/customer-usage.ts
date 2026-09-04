import { z } from "zod";

const identitySchema = z.object({
	provider: z.string(),
	normalizedApiOrigin: z.string(),
	upstreamSkuId: z.string(),
	customerUsageUrl: z.unknown().optional(),
});
const guideSchema = z.object({
	supplierUsageGuide: z.object({
		provider: z.string(),
		origin: z.string(),
		skuId: z.string(),
		url: z.string(),
	}),
});

function decode(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function publicUsageUrl(value: unknown): string | null {
	const parsed = z.string().trim().min(1).max(2048).safeParse(value);
	if (!parsed.success) return null;
	try {
		const url = new URL(parsed.data);
		if (url.protocol !== "https:" || url.username || url.password) return null;
		if (
			[...url.searchParams.keys()].some((key) =>
				/^(?:token|api_key|key|sign|authorization|password|secret)$/i.test(key),
			)
		)
			return null;
		return url.href;
	} catch {
		return null;
	}
}

/** Optional operator-verified product instructions, never the trade payment URL. */
export function resolveSupplierUsageUrl(
	policy: unknown,
	bindingSnapshot: unknown,
): string | null {
	const identity = identitySchema.safeParse(decode(bindingSnapshot));
	if (!identity.success) return null;
	// New paid orders freeze the guide, including an explicitly absent guide.
	if (Object.hasOwn(identity.data, "customerUsageUrl"))
		return publicUsageUrl(identity.data.customerUsageUrl);
	const parsed = guideSchema.safeParse(decode(policy));
	if (!parsed.success) return null;
	const guide = parsed.data.supplierUsageGuide;
	if (
		guide.provider !== identity.data.provider ||
		guide.origin !== identity.data.normalizedApiOrigin ||
		guide.skuId !== identity.data.upstreamSkuId
	)
		return null;
	return publicUsageUrl(guide.url);
}
