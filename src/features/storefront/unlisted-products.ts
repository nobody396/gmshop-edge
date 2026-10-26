import { claudeEnvTrafficProductId } from "#/features/claude-env/domain";

/**
 * Purchasable products that never appear on the homepage, catalog, tag counts
 * or sitemap: they are sold only through a direct link (e.g. the Claude env
 * customer panel's 「加流量」 checkout links).
 */
export const unlistedProductIds: readonly string[] = [
	claudeEnvTrafficProductId,
];

/** `AND <alias>.id NOT IN (…)` with literal UUIDs (constants, never input). */
export function unlistedProductFilter(alias: string) {
	return `${alias}.id NOT IN (${unlistedProductIds.map((id) => `'${id}'`).join(",")})`;
}
