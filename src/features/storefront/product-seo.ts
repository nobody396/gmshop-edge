import { queryOptions } from "@tanstack/react-query";
import { getStorefrontProductFn } from "#/features/storefront/server/catalog";
import { formatMinorAmountWithSymbol } from "#/lib/format";
import type { SupportedLocale } from "#/lib/locales";
import { jsonLdScript } from "#/lib/seo";
import { absoluteSiteUrl } from "#/lib/site-url";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export type StorefrontProduct = Awaited<
	ReturnType<typeof getStorefrontProductFn>
>;

/** One cache entry shared by the route loader (SSR) and the product page. */
export function storefrontProductQueryOptions(input: {
	locale: SupportedLocale;
	productId: string;
}) {
	return queryOptions({
		queryKey: ["storefront", "product", input.locale, input.productId],
		queryFn: () => getStorefrontProductFn({ data: input }),
		staleTime: 30_000,
	});
}

const DESCRIPTION_LIMIT = 120;

type PriceSummary = {
	lowMinor: bigint;
	highMinor: bigint;
	currency: string;
	decimals: number;
	offerCount: number;
	inStock: boolean;
};

/** Purchasable plans only: the lowest price must be one a buyer can pay. */
export function productPriceSummary(
	product: StorefrontProduct,
): PriceSummary | null {
	const plans = product.sellableItems.filter((item) => !item.saleDisabled);
	const priced = plans.length > 0 ? plans : product.sellableItems;
	const first = priced[0];
	if (!first) return null;
	let lowMinor = BigInt(first.priceMinor);
	let highMinor = lowMinor;
	for (const item of priced) {
		const price = BigInt(item.priceMinor);
		if (price < lowMinor) lowMinor = price;
		if (price > highMinor) highMinor = price;
	}
	return {
		lowMinor,
		highMinor,
		currency: first.currency,
		decimals: first.currencyDecimals,
		offerCount: priced.length,
		inStock:
			!product.saleDisabled &&
			plans.some(
				(item) =>
					item.availableStock < 0 ||
					item.availableStock >= item.minimumQuantity,
			),
	};
}

/** Collapses stored product HTML/markdown into one plain sentence-sized snippet. */
export function plainTextSnippet(value: string, limit = DESCRIPTION_LIMIT) {
	const text = value
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/[#*_`>|[\]]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = Array.from(text);
	if (characters.length <= limit) return text;
	return `${characters.slice(0, limit).join("").trimEnd()}…`;
}

export function productSeoDescription(
	product: StorefrontProduct,
	locale = getLocale(),
) {
	const fromDescription = plainTextSnippet(product.description ?? "");
	if (Array.from(fromDescription).length >= 30) return fromDescription;
	const summary = productPriceSummary(product);
	const plans = product.sellableItems
		.slice(0, 6)
		.map((item) => item.name)
		.join(locale === "zh-CN" ? "、" : ", ");
	return m.seo_product_description_fallback(
		{
			name: product.name,
			plans: plans || product.name,
			price: summary
				? formatMinorAmountWithSymbol(
						summary.lowMinor,
						summary.currency,
						summary.decimals,
						locale,
					)
				: "",
		},
		{ locale },
	);
}

function decimalAmount(amountMinor: bigint, decimals: number) {
	if (decimals === 0) return amountMinor.toString();
	const padded = amountMinor.toString().padStart(decimals + 1, "0");
	return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}

export function productJsonLd(
	product: StorefrontProduct,
	locale = getLocale(),
) {
	const url = absoluteSiteUrl(`/products/${product.id}`);
	const summary = productPriceSummary(product);
	return {
		"@context": "https://schema.org",
		"@type": "Product",
		name: product.name,
		description: productSeoDescription(product, locale),
		...(product.coverUrl ? { image: absoluteSiteUrl(product.coverUrl) } : {}),
		url,
		...(summary
			? {
					offers: {
						"@type": "AggregateOffer",
						lowPrice: decimalAmount(summary.lowMinor, summary.decimals),
						highPrice: decimalAmount(summary.highMinor, summary.decimals),
						priceCurrency: summary.currency.toUpperCase(),
						offerCount: summary.offerCount,
						availability: summary.inStock
							? "https://schema.org/InStock"
							: "https://schema.org/OutOfStock",
						url,
					},
				}
			: {}),
	};
}

export function createProductSeoHead(
	product: StorefrontProduct,
	siteName: string,
	locale = getLocale(),
) {
	const title = `${product.name}｜${m.seo_product_title_suffix({}, { locale })} – ${siteName}`;
	const description = productSeoDescription(product, locale);
	const url = absoluteSiteUrl(`/products/${product.id}`);
	const image = product.coverUrl ? absoluteSiteUrl(product.coverUrl) : null;
	return {
		meta: [
			{ title },
			{ name: "title", content: title },
			{ name: "description", content: description },
			{ property: "og:type", content: "product" },
			{ property: "og:site_name", content: siteName },
			{ property: "og:url", content: url },
			{ property: "og:locale", content: locale.replace("-", "_") },
			{ property: "og:title", content: title },
			{ property: "og:description", content: description },
			...(image ? [{ property: "og:image", content: image }] : []),
			{
				name: "twitter:card",
				content: image ? "summary_large_image" : "summary",
			},
			{ name: "twitter:title", content: title },
			{ name: "twitter:description", content: description },
			...(image ? [{ name: "twitter:image", content: image }] : []),
		],
		links: [{ rel: "canonical", href: url }],
		scripts: [jsonLdScript(productJsonLd(product, locale))],
	};
}
