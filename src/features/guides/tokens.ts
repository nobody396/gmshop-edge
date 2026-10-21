/**
 * Live tokens inside guide markdown keep prices and product names current:
 *   {{price:<sellable-item-id>}}  → "¥139.00" or "暂时缺货"
 *   {{product:<product-id>}}      → "[商品名](/products/<id>)"
 * Any other or unresolvable {{…}} token is removed, never shown raw.
 */

export const GUIDE_OUT_OF_STOCK_LABEL = "暂时缺货";

export type GuideTokenRef = { kind: "price" | "product"; id: string };

export type GuideTokenValues = {
	/** Formatted price, or null when the plan exists but cannot be bought now. */
	prices: ReadonlyMap<string, string | null>;
	products: ReadonlyMap<string, { name: string }>;
};

const TOKEN_PATTERN = /\{\{([^{}\n]{0,200})\}\}/g;
const TOKEN_BODY = /^\s*(price|product)\s*:\s*([A-Za-z0-9-]{1,64})\s*$/;

function parseToken(body: string): GuideTokenRef | null {
	const match = TOKEN_BODY.exec(body);
	if (!match?.[1] || !match[2]) return null;
	return { kind: match[1] as GuideTokenRef["kind"], id: match[2] };
}

/** Distinct ids referenced by well-formed tokens, for one batched lookup. */
export function collectGuideTokens(markdown: string) {
	const priceIds = new Set<string>();
	const productIds = new Set<string>();
	for (const match of markdown.matchAll(TOKEN_PATTERN)) {
		const token = parseToken(match[1] ?? "");
		if (token?.kind === "price") priceIds.add(token.id);
		if (token?.kind === "product") productIds.add(token.id);
	}
	return { priceIds: [...priceIds], productIds: [...productIds] };
}

function escapeMarkdownText(value: string) {
	return value.replace(/[\\`*_[\]<>()#!|~]/g, (character) => `\\${character}`);
}

export function replaceGuideTokens(
	markdown: string,
	values: GuideTokenValues,
): { markdown: string; unknownTokens: string[] } {
	const unknownTokens: string[] = [];
	const output = markdown.replace(TOKEN_PATTERN, (raw, body: string) => {
		const token = parseToken(body);
		if (token?.kind === "price" && values.prices.has(token.id))
			return values.prices.get(token.id) ?? GUIDE_OUT_OF_STOCK_LABEL;
		if (token?.kind === "product") {
			const product = values.products.get(token.id);
			if (product)
				return `[${escapeMarkdownText(product.name)}](/products/${token.id})`;
		}
		unknownTokens.push(raw);
		return "";
	});
	return { markdown: output, unknownTokens };
}
