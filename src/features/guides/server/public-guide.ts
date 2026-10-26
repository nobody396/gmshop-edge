import { beijingDate, reservedGuideSlugs } from "#/features/guides/content";
import type { GuideFaqItem } from "#/features/guides/server/rules";
import {
	collectGuideTokens,
	replaceGuideTokens,
} from "#/features/guides/tokens";
import {
	storefrontCatalogStockExpression,
	storefrontStockExpression,
} from "#/features/storefront/server/stock-availability";
import { formatMinorAmountWithSymbol } from "#/lib/format";
import { renderGuideMarkdown } from "./markdown";
import { getGuide, getPublishedGuide, listPublishedGuides } from "./store";

export type PublicGuideProduct = {
	id: string;
	name: string;
	/** "¥139.00 起" style label; null when no plan has a price. */
	priceLabel: string | null;
	inStock: boolean;
};

export type PublicGuide = {
	slug: string;
	title: string;
	description: string;
	html: string;
	faq: GuideFaqItem[];
	relatedProducts: PublicGuideProduct[];
	publishedAt: number | null;
	updatedAt: number;
	updatedDate: string;
};

export type PublicGuideListItem = {
	slug: string;
	path: string;
	title: string;
	description: string;
	updatedDate: string | null;
};

const visibleProduct = "p.status = 'active' AND p.trashed_at IS NULL";

function placeholders(count: number) {
	return Array.from({ length: count }, () => "?").join(", ");
}

/** Current price per sellable item; null = exists but cannot be bought now. */
async function loadItemPrices(db: D1Database, ids: readonly string[]) {
	const prices = new Map<string, string | null>();
	if (!ids.length) return prices;
	const result = await db
		.prepare(
			`SELECT item.id, item.price_minor, item.currency, item.currency_decimals,
			  item.minimum_quantity, item.enabled, item.sale_disabled,
			  p.sale_disabled AS product_sale_disabled,
			  ${storefrontStockExpression("p", "item")} AS available_stock
			 FROM product_sellable_items item
			 JOIN products p ON p.id = item.product_id
			 WHERE item.id IN (${placeholders(ids.length)}) AND ${visibleProduct}`,
		)
		.bind(...ids)
		.all<{
			id: string;
			price_minor: string;
			currency: string;
			currency_decimals: number;
			minimum_quantity: number;
			enabled: number;
			sale_disabled: number;
			product_sale_disabled: number;
			available_stock: number;
		}>();
	for (const row of result.results) {
		const stock = Number(row.available_stock);
		const purchasable =
			Boolean(row.enabled) &&
			!row.sale_disabled &&
			!row.product_sale_disabled &&
			(stock < 0 || stock >= Number(row.minimum_quantity));
		prices.set(
			row.id,
			purchasable
				? formatMinorAmountWithSymbol(
						row.price_minor,
						row.currency,
						Number(row.currency_decimals),
						"zh-CN",
					)
				: null,
		);
	}
	return prices;
}

async function loadProducts(db: D1Database, ids: readonly string[]) {
	const products = new Map<string, PublicGuideProduct>();
	if (!ids.length) return products;
	const result = await db
		.prepare(
			`SELECT p.id, p.name, p.sale_disabled,
			  (SELECT item.price_minor FROM product_sellable_items item
			   WHERE item.product_id = p.id AND item.enabled = 1 AND item.sale_disabled = 0
			   ORDER BY length(item.price_minor), item.price_minor, item.id LIMIT 1) AS min_price_minor,
			  (SELECT item.currency FROM product_sellable_items item
			   WHERE item.product_id = p.id AND item.enabled = 1
			   ORDER BY item.sort_order, item.id LIMIT 1) AS currency,
			  (SELECT item.currency_decimals FROM product_sellable_items item
			   WHERE item.product_id = p.id AND item.enabled = 1
			   ORDER BY item.sort_order, item.id LIMIT 1) AS currency_decimals,
			  (SELECT ${storefrontCatalogStockExpression("p", "item")}
			   FROM product_sellable_items item
			   WHERE item.product_id = p.id AND item.enabled = 1 AND item.sale_disabled = 0) AS stock,
			  EXISTS (SELECT 1 FROM product_sellable_items item
			   WHERE item.product_id = p.id AND item.enabled = 1 AND item.sale_disabled = 0
			    AND (p.product_type <> 'stock' OR item.fulfillment_source = 'manual')) AS unlimited
			 FROM products p
			 WHERE p.id IN (${placeholders(ids.length)}) AND ${visibleProduct}`,
		)
		.bind(...ids)
		.all<{
			id: string;
			name: string;
			sale_disabled: number;
			min_price_minor: string | null;
			currency: string | null;
			currency_decimals: number | null;
			stock: number | null;
			unlimited: number;
		}>();
	for (const row of result.results)
		products.set(row.id, {
			id: row.id,
			name: row.name,
			priceLabel: row.min_price_minor
				? `${formatMinorAmountWithSymbol(
						row.min_price_minor,
						row.currency ?? "CNY",
						Number(row.currency_decimals ?? 2),
						"zh-CN",
					)} 起`
				: null,
			inStock:
				!row.sale_disabled &&
				row.min_price_minor !== null &&
				(Boolean(row.unlimited) || Number(row.stock ?? 0) > 0),
		});
	return products;
}

export async function loadPublicGuide(
	db: D1Database,
	slug: string,
): Promise<PublicGuide | null> {
	if (reservedGuideSlugs.has(slug)) return null;
	const guide = await getPublishedGuide(db, slug);
	if (!guide) return null;
	return renderGuide(db, guide, slug);
}

/**
 * A guide kept as a draft on purpose (never public) and shown only to the
 * buyers allowed to read it — the caller checks who may see it.
 */
export async function loadPrivateGuide(
	db: D1Database,
	slug: string,
): Promise<PublicGuide | null> {
	const guide = await getGuide(db, slug);
	if (!guide) return null;
	return renderGuide(db, guide, slug);
}

async function renderGuide(
	db: D1Database,
	guide: NonNullable<Awaited<ReturnType<typeof getGuide>>>,
	slug: string,
): Promise<PublicGuide> {
	const tokens = collectGuideTokens(guide.bodyMd);
	const productIds = [
		...new Set([...tokens.productIds, ...guide.relatedProductIds]),
	];
	const [prices, products] = await Promise.all([
		loadItemPrices(db, tokens.priceIds),
		loadProducts(db, productIds),
	]);
	const replaced = replaceGuideTokens(guide.bodyMd, { prices, products });
	if (replaced.unknownTokens.length)
		console.warn(
			JSON.stringify({
				event: "guide_unknown_tokens",
				slug,
				tokens: replaced.unknownTokens,
			}),
		);
	return {
		slug: guide.slug,
		title: guide.title,
		description: guide.description,
		html: renderGuideMarkdown(replaced.markdown),
		faq: guide.faq,
		relatedProducts: guide.relatedProductIds.flatMap((id) => {
			const product = products.get(id);
			return product ? [product] : [];
		}),
		publishedAt: guide.publishedAt,
		updatedAt: guide.updatedAt,
		updatedDate: beijingDate(guide.updatedAt),
	};
}

/** Tokens a draft would drop when rendered today (reported back to the writer). */
export async function findUnresolvedGuideTokens(
	db: D1Database,
	markdown: string,
) {
	const tokens = collectGuideTokens(markdown);
	const [prices, products] = await Promise.all([
		loadItemPrices(db, tokens.priceIds),
		loadProducts(db, tokens.productIds),
	]);
	return replaceGuideTokens(markdown, { prices, products }).unknownTokens;
}

export async function loadPublicGuideList(
	db: D1Database,
): Promise<PublicGuideListItem[]> {
	const guides = await listPublishedGuides(db);
	return guides
		.filter((guide) => !reservedGuideSlugs.has(guide.slug))
		.map((guide) => ({
			slug: guide.slug,
			path: `/guides/${guide.slug}`,
			title: guide.title,
			description: guide.description,
			updatedDate: beijingDate(guide.updatedAt),
		}));
}
