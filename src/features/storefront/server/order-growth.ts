import { z } from "zod";
import { agentAccessProducts } from "#/features/agent-access/products";
import { pricePromotion } from "#/features/promotions/pricing";
import { storefrontStockExpression } from "./stock-availability";

export const crossSellSettingKey = "growth.cross_sell";
const maxRecommendations = 3;
const maxRecommendationCandidates = 30;
const growthStatuses = new Set(["paid", "fulfilling", "completed"]);
const agentAccessProductIds = new Set<string>(
	Object.values(agentAccessProducts).map((product) => product.productId),
);

const crossSellSchema = z.record(
	z.string().min(1).max(64),
	z.array(z.string().min(1).max(64)),
);

/** purchased sellable_item_id → recommended ids. Malformed settings mean "no recommendations". */
export function parseCrossSellSetting(raw: unknown) {
	let value = raw;
	if (typeof value === "string")
		try {
			value = JSON.parse(value);
		} catch {
			return new Map<string, string[]>();
		}
	const parsed = crossSellSchema.safeParse(value);
	if (!parsed.success) return new Map<string, string[]>();
	return new Map(
		Object.entries(parsed.data).map(([itemId, ids]) => [
			itemId,
			[...new Set(ids)].slice(0, maxRecommendations),
		]),
	);
}

/** Same shape as the renewal repurchase link; `ref=xsell` is attribution only (referral capture accepts INV- codes). */
export function crossSellProductPath(
	productId: string,
	sellableItemId: string,
) {
	const search = new URLSearchParams({ item: sellableItemId, src: "order" });
	return `/products/${encodeURIComponent(productId)}?${search}#purchase-options`;
}

export type OrderGrowth = {
	signedIn: boolean;
	/** Friend discount (= referrer reward) for one unit of the purchased item, CNY cents. */
	/** Best single-unit invitation among this order's items: friend discount and referrer reward, CNY cents. */
	referralDiscountMinor: string;
	referralRewardMinor: string;
	crossSell: Array<{
		sellableItemId: string;
		productId: string;
		productName: string;
		sellableItemName: string;
		priceMinor: string;
		currency: string;
		currencyDecimals: number;
		coverUrl: string | null;
		href: string;
	}>;
};

/**
 * Whether an order may show invitation prompts (order page block, delivery
 * email line): same rules as loadOrderGrowth, in one query whose bindings do
 * not grow with the order size, and without loading recommendations.
 */
export async function isGrowthEligibleOrder(
	db: D1Database,
	order: { id: string; status: string; refundedAt: number | null },
) {
	if (!growthStatuses.has(order.status) || order.refundedAt != null)
		return false;
	const agentIds = [...agentAccessProductIds];
	const row = await db
		.prepare(
			`SELECT EXISTS(SELECT 1 FROM shop_order_items WHERE order_id = ?) AS has_items,
			 EXISTS(SELECT 1 FROM supplier_api_orders WHERE shop_order_id = ?) AS via_supplier_api,
			 EXISTS(SELECT 1 FROM shop_order_items WHERE order_id = ?
			  AND product_id IN (${agentIds.map(() => "?").join(",")})) AS agent_access`,
		)
		.bind(order.id, order.id, order.id, ...agentIds)
		.first<{
			has_items: number;
			via_supplier_api: number;
			agent_access: number;
		}>();
	return Boolean(row?.has_items && !row.via_supplier_api && !row.agent_access);
}

/**
 * Growth blocks for the customer order page. Only paid storefront orders get them:
 * never agent-access purchases and never orders placed through the supplier API.
 */
export async function loadOrderGrowth(
	db: D1Database,
	order: { id: string; status: string; refundedAt: number | null },
	access: { signedIn: boolean },
): Promise<OrderGrowth | null> {
	if (!growthStatuses.has(order.status) || order.refundedAt != null)
		return null;
	const [itemsResult, supplierResult, settingResult] = await db.batch([
		db
			.prepare(
				`SELECT oi.product_id, oi.sellable_item_id,
				 CASE WHEN COALESCE(s.promotion_budget_minor,'0')='0' THEN '0'
				  ELSE COALESCE(s.referral_budget_minor,'0') END AS promotion_budget_minor,
				 s.price_minor, s.currency
				 FROM shop_order_items oi
				 LEFT JOIN product_sellable_items s ON s.id = oi.sellable_item_id
				 WHERE oi.order_id = ? ORDER BY oi.created_at, oi.id`,
			)
			.bind(order.id),
		db
			.prepare(
				"SELECT 1 AS found FROM supplier_api_orders WHERE shop_order_id = ? LIMIT 1",
			)
			.bind(order.id),
		db
			.prepare("SELECT value FROM system_settings WHERE key = ? LIMIT 1")
			.bind(crossSellSettingKey),
	]);
	const items = (itemsResult?.results ?? []) as Array<{
		product_id: string;
		sellable_item_id: string | null;
		promotion_budget_minor: string;
		price_minor: string | null;
		currency: string | null;
	}>;
	if (
		!items.length ||
		supplierResult?.results.length ||
		items.some((item) => agentAccessProductIds.has(item.product_id))
	)
		return null;
	const purchased = new Set(
		items.flatMap((item) =>
			item.sellable_item_id ? [item.sellable_item_id] : [],
		),
	);
	const mapping = parseCrossSellSetting(
		(settingResult?.results[0] as { value?: unknown } | undefined)?.value,
	);
	const candidates = [
		...new Set([...purchased].flatMap((itemId) => mapping.get(itemId) ?? [])),
	]
		.filter((id) => !purchased.has(id))
		// Bounded so a many-SKU order stays under D1's 100 bound parameters.
		.slice(0, maxRecommendationCandidates);
	const referral = referralQuoteFor(items);
	return {
		signedIn: access.signedIn,
		referralDiscountMinor: referral.discountMinor,
		referralRewardMinor: referral.rewardMinor,
		crossSell: await loadRecommendations(db, candidates),
	};
}

function referralQuoteFor(
	items: Array<{
		sellable_item_id: string | null;
		promotion_budget_minor: string;
		price_minor: string | null;
		currency: string | null;
	}>,
) {
	let best = { discount: 0n, reward: 0n };
	for (const item of items) {
		if (
			!item.sellable_item_id ||
			item.currency !== "CNY" ||
			!item.price_minor ||
			item.promotion_budget_minor === "0"
		)
			continue;
		try {
			const quote = pricePromotion("referral", [
				{
					id: item.sellable_item_id,
					budgetMinor: item.promotion_budget_minor,
					subtotalMinor: item.price_minor,
					quantity: 1,
				},
			]);
			const reward = BigInt(quote.rewardMinor);
			if (reward > best.reward)
				best = { discount: BigInt(quote.discountMinor), reward };
		} catch {
			/* An invalid SKU budget simply shows the generic invitation copy. */
		}
	}
	return {
		discountMinor: best.discount.toString(),
		rewardMinor: best.reward.toString(),
	};
}

async function loadRecommendations(db: D1Database, ids: string[]) {
	if (!ids.length) return [];
	const rows = await db
		.prepare(
			`SELECT s.id, s.name, s.price_minor, s.currency, s.currency_decimals,
			 p.id AS product_id, p.name AS product_name, p.cover_object_key, p.updated_at,
			 ${storefrontStockExpression("p", "s")} AS available_stock
			 FROM product_sellable_items s JOIN products p ON p.id = s.product_id
			 WHERE s.id IN (${ids.map(() => "?").join(",")})
			  AND s.enabled = 1 AND s.sale_disabled = 0
			  AND p.status = 'active' AND p.sale_disabled = 0`,
		)
		.bind(...ids)
		.all<{
			id: string;
			name: string;
			price_minor: string;
			currency: string;
			currency_decimals: number;
			product_id: string;
			product_name: string;
			cover_object_key: string | null;
			updated_at: number;
			available_stock: number;
		}>();
	const byId = new Map(rows.results.map((row) => [row.id, row]));
	return ids
		.flatMap((id) => {
			const row = byId.get(id);
			return row && Number(row.available_stock) !== 0 ? [row] : [];
		})
		.slice(0, maxRecommendations)
		.map((row) => ({
			sellableItemId: row.id,
			productId: row.product_id,
			productName: row.product_name,
			sellableItemName: row.name,
			priceMinor: String(row.price_minor),
			currency: row.currency,
			currencyDecimals: Number(row.currency_decimals),
			coverUrl: row.cover_object_key
				? `/api/shop/products/${row.product_id}/cover?v=${row.updated_at}`
				: null,
			href: crossSellProductPath(row.product_id, row.id),
		}));
}

/** `/go/item/{id}` target: the product page with the item preselected, else the home page. */
export async function resolveItemLinkPath(
	db: D1Database,
	itemId: string,
	source: string | null,
) {
	if (!/^[A-Za-z0-9-]{1,64}$/.test(itemId)) return "/";
	const row = await db
		.prepare(
			`SELECT s.product_id FROM product_sellable_items s
			 JOIN products p ON p.id = s.product_id
			 WHERE s.id = ? AND s.enabled = 1 AND p.status = 'active' LIMIT 1`,
		)
		.bind(itemId)
		.first<{ product_id: string }>();
	if (!row) return "/";
	const search = new URLSearchParams({ item: itemId });
	const src = source?.trim();
	if (src && /^[A-Za-z0-9_-]{1,32}$/.test(src)) search.set("src", src);
	return `/products/${encodeURIComponent(row.product_id)}?${search}#purchase-options`;
}

export async function withOrderGrowth<
	T extends { id: string; status: string; refundedAt: number | null },
>(db: D1Database, order: T, access: { signedIn: boolean }) {
	return { ...order, growth: await loadOrderGrowth(db, order, access) };
}
