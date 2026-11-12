import { queryOptions } from "@tanstack/react-query";
import { gptUpgradeProduct } from "#/features/gpt-upgrade/products";
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
	// The upgrade's zero list price is a placeholder: never show or publish it as a price.
	if (product.id === gptUpgradeProduct.productId) return null;
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

type SellableItem = StorefrontProduct["sellableItems"][number];

/** Product URL; `itemId` adds the spec landing parameter. Nothing else ever does. */
export function productPageUrl(productId: string, itemId?: string) {
	const path = `/products/${productId}`;
	return absoluteSiteUrl(
		itemId ? `${path}?item=${encodeURIComponent(itemId)}` : path,
	);
}

/**
 * Plans a buyer can actually pick: disabled plans never leave the server and
 * paused ones (sale disabled) are skipped. The quote-based upgrade has no
 * real list price, so it publishes none.
 */
export function publicSellableItems(product: StorefrontProduct) {
	if (product.id === gptUpgradeProduct.productId) return [];
	return product.sellableItems.filter((item) => !item.saleDisabled);
}

function itemInStock(product: StorefrontProduct, item: SellableItem) {
	return (
		!product.saleDisabled &&
		(item.availableStock < 0 || item.availableStock >= item.minimumQuantity)
	);
}

/**
 * The plan a `?item=` URL stands for when it deserves its own indexable page:
 * a public plan of a product that sells more than one. Anything else (unknown,
 * paused, single-plan, product off sale) canonicalises to the product URL.
 */
export function productLandingItem(
	product: StorefrontProduct,
	itemId: string | undefined,
) {
	if (!itemId || product.saleDisabled) return null;
	const items = publicSellableItems(product);
	if (items.length < 2) return null;
	return items.find((item) => item.id === itemId) ?? null;
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

function itemOffer(
	product: StorefrontProduct,
	item: SellableItem,
	url: string,
) {
	return {
		"@type": "Offer",
		name: item.name,
		sku: item.id,
		price: decimalAmount(BigInt(item.priceMinor), item.currencyDecimals),
		priceCurrency: item.currency.toUpperCase(),
		availability: itemInStock(product, item)
			? "https://schema.org/InStock"
			: "https://schema.org/OutOfStock",
		url,
	};
}

export function productJsonLd(
	product: StorefrontProduct,
	locale = getLocale(),
) {
	const url = productPageUrl(product.id);
	const summary = productPriceSummary(product);
	const items = publicSellableItems(product);
	// Single-plan products have no spec landing pages; their offer is the page.
	const offers = items.map((item) =>
		itemOffer(
			product,
			item,
			items.length > 1 ? productPageUrl(product.id, item.id) : url,
		),
	);
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
						...(offers.length ? { offers } : {}),
					},
				}
			: {}),
	};
}

function itemPrice(item: SellableItem, locale: SupportedLocale) {
	return formatMinorAmountWithSymbol(
		item.priceMinor,
		item.currency,
		item.currencyDecimals,
		locale,
	);
}

/** Spec landing snippet: plan, price, stock, delivery, then the plan's own terms. */
export function productItemSeoDescription(
	product: StorefrontProduct,
	item: SellableItem,
	locale = getLocale(),
) {
	const lead = m.seo_product_item_description(
		{
			name: product.name,
			plan: item.name,
			price: itemPrice(item, locale),
			stock: itemInStock(product, item)
				? m.seo_product_stock_in({}, { locale })
				: m.seo_product_stock_out({}, { locale }),
			delivery:
				item.fulfillmentSource === "manual"
					? m.seo_product_item_delivery_manual({}, { locale })
					: m.seo_product_item_delivery_auto({}, { locale }),
		},
		{ locale },
	);
	const chinese = locale === "zh-CN";
	const terms = [item.policy.coverage, item.policy.warranty]
		.map((text) =>
			plainTextSnippet(text ?? "", 200).replace(/[。.;；\s]+$/, ""),
		)
		.filter(Boolean);
	let text = terms.length
		? `${lead}${chinese ? "" : " "}${terms.join(chinese ? "；" : "; ")}${chinese ? "。" : "."}`
		: lead;
	if (Array.from(text).length < 70) {
		const about = plainTextSnippet(product.description ?? "");
		if (about) text = `${text}${chinese ? "" : " "}${about}`;
	}
	return plainTextSnippet(text, 150);
}

function productItemJsonLd(
	product: StorefrontProduct,
	item: SellableItem,
	locale: SupportedLocale,
) {
	const url = productPageUrl(product.id, item.id);
	return {
		"@context": "https://schema.org",
		"@type": "Product",
		name: `${product.name}｜${item.name}`,
		description: productItemSeoDescription(product, item, locale),
		...(product.coverUrl ? { image: absoluteSiteUrl(product.coverUrl) } : {}),
		sku: item.id,
		url,
		offers: itemOffer(product, item, url),
	};
}

/**
 * Head for /products/:id. A valid `?item=` of a multi-plan product becomes its
 * own landing page (title, snippet, self canonical with `item`); any other
 * query string, including utm_* and ref, canonicalises to the product URL.
 */
export function createProductSeoHead(
	product: StorefrontProduct,
	siteName: string,
	locale = getLocale(),
	itemId?: string,
) {
	const item = productLandingItem(product, itemId);
	const title = item
		? `${product.name}｜${item.name}｜${itemPrice(item, locale)} – ${siteName}`
		: `${product.name}｜${m.seo_product_title_suffix({}, { locale })} – ${siteName}`;
	const description = item
		? productItemSeoDescription(product, item, locale)
		: productSeoDescription(product, locale);
	const url = productPageUrl(product.id, item?.id);
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
		scripts: [
			jsonLdScript(
				item
					? productItemJsonLd(product, item, locale)
					: productJsonLd(product, locale),
			),
		],
	};
}
