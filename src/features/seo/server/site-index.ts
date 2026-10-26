import {
	reservedGuideSlugs,
	staticGuidePages,
} from "#/features/guides/content";
import {
	type GuideSummary,
	listPublishedGuides,
} from "#/features/guides/server/store";
import { retiredTwentyRenewProductId } from "#/features/home/buying-guide-rules";
import { unlistedProductFilter } from "#/features/storefront/unlisted-products";
import { formatMinorAmountWithSymbol } from "#/lib/format";
import { SITE_URL } from "#/lib/site-url";

/** Public, indexable hand-built guide pages under /guides. */
export const publicGuidePages = staticGuidePages;

/** A published, stored guide as the site index needs it. */
export type IndexedGuide = Pick<
	GuideSummary,
	"slug" | "title" | "description" | "updatedAt"
>;

export async function listIndexedGuides(
	db: D1Database,
): Promise<IndexedGuide[]> {
	return (await listPublishedGuides(db)).filter(
		(guide) => !reservedGuideSlugs.has(guide.slug),
	);
}

/** Price-difference top-up: a utility checkout, not a product to index. */
const priceDifferenceProductId = "643ba58d-3441-4ac5-b2e4-4a4007f24cc0";

export type IndexedProduct = {
	id: string;
	name: string;
	description: string;
	category: string;
	updatedAt: number;
	minPriceMinor: string | null;
	currency: string;
	currencyDecimals: number;
	planCount: number;
	manualOnly: boolean;
};

export async function listIndexedProducts(
	db: D1Database,
): Promise<IndexedProduct[]> {
	const result = await db
		.prepare(
			`SELECT p.id, p.name, p.description, p.updated_at,
			  COALESCE(json_extract(p.tag_names, '$[0]'), '') AS category,
			  (SELECT item.price_minor FROM product_sellable_items item
			   WHERE item.product_id = p.id AND item.enabled = 1 AND item.sale_disabled = 0
			   ORDER BY length(item.price_minor), item.price_minor, item.id LIMIT 1) AS min_price_minor,
			  (SELECT item.currency FROM product_sellable_items item
			   WHERE item.product_id = p.id AND item.enabled = 1
			   ORDER BY item.sort_order, item.id LIMIT 1) AS currency,
			  (SELECT item.currency_decimals FROM product_sellable_items item
			   WHERE item.product_id = p.id AND item.enabled = 1
			   ORDER BY item.sort_order, item.id LIMIT 1) AS currency_decimals,
			  (SELECT COUNT(*) FROM product_sellable_items item
			   WHERE item.product_id = p.id AND item.enabled = 1 AND item.sale_disabled = 0) AS plan_count,
			  NOT EXISTS (SELECT 1 FROM product_sellable_items item
			   WHERE item.product_id = p.id AND item.enabled = 1
			    AND item.fulfillment_source <> 'manual') AS manual_only
			 FROM products p
			 WHERE p.status = 'active' AND p.trashed_at IS NULL AND p.sale_disabled = 0
			  AND p.id NOT IN (?, ?) AND ${unlistedProductFilter("p")}
			 ORDER BY p.sort_order, p.created_at DESC, p.id
			 LIMIT 500`,
		)
		.bind(retiredTwentyRenewProductId, priceDifferenceProductId)
		.all<{
			id: string;
			name: string;
			description: string | null;
			updated_at: number;
			category: string;
			min_price_minor: string | null;
			currency: string | null;
			currency_decimals: number | null;
			plan_count: number;
			manual_only: number;
		}>();
	return result.results.map((row) => ({
		id: row.id,
		name: row.name,
		description: row.description ?? "",
		category: row.category,
		updatedAt: Number(row.updated_at),
		minPriceMinor: row.min_price_minor,
		currency: row.currency ?? "CNY",
		currencyDecimals: Number(row.currency_decimals ?? 2),
		planCount: Number(row.plan_count),
		manualOnly: Boolean(row.manual_only),
	}));
}

function escapeXml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function renderSitemap(
	products: readonly IndexedProduct[],
	guides: readonly IndexedGuide[] = [],
) {
	const entries = [
		{ loc: `${SITE_URL}/`, lastmod: latest(products), priority: "1.0" },
		...products.map((product) => ({
			loc: `${SITE_URL}/products/${product.id}`,
			lastmod: product.updatedAt,
			priority: "0.8",
		})),
		{ loc: `${SITE_URL}/guides`, lastmod: latest(guides), priority: "0.6" },
		...guides.map((guide) => ({
			loc: `${SITE_URL}/guides/${guide.slug}`,
			lastmod: guide.updatedAt,
			priority: "0.6",
		})),
		...publicGuidePages.map((guide) => ({
			loc: `${SITE_URL}${guide.path}`,
			lastmod: undefined,
			priority: "0.6",
		})),
	];
	const urls = entries.map((entry) =>
		[
			"  <url>",
			`    <loc>${escapeXml(entry.loc)}</loc>`,
			...(entry.lastmod
				? [`    <lastmod>${new Date(entry.lastmod).toISOString()}</lastmod>`]
				: []),
			`    <priority>${entry.priority}</priority>`,
			"  </url>",
		].join("\n"),
	);
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		...urls,
		"</urlset>",
		"",
	].join("\n");
}

function latest(entries: readonly { updatedAt: number }[]) {
	let value: number | undefined;
	for (const entry of entries)
		if (!value || entry.updatedAt > value) value = entry.updatedAt;
	return value;
}

function oneLine(value: string, limit: number) {
	const text = value
		.replace(/<[^>]+>/g, " ")
		.replace(/[#*_`>|[\]]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = Array.from(text);
	return characters.length <= limit
		? text
		: `${characters.slice(0, limit).join("").trimEnd()}…`;
}

/**
 * Plain-language site summary for AI assistants (llmstxt.org). Generated from
 * the live catalog so categories and prices never drift from the storefront.
 */
export function renderLlmsTxt(
	products: readonly IndexedProduct[],
	siteName: string,
	guides: readonly IndexedGuide[] = [],
) {
	const groups = new Map<string, IndexedProduct[]>();
	for (const product of products) {
		const category = product.category || "其他";
		groups.set(category, [...(groups.get(category) ?? []), product]);
	}
	const catalog = [...groups].flatMap(([category, items]) => [
		`### ${category}`,
		"",
		...items.map((product) => {
			const price = product.minPriceMinor
				? `，${formatMinorAmountWithSymbol(product.minPriceMinor, product.currency, product.currencyDecimals, "zh-CN")} 起`
				: "";
			const plans =
				product.planCount > 1 ? `，${product.planCount} 个规格` : "";
			const delivery = product.manualOnly
				? "，客服人工处理"
				: "，24 小时自动发货";
			const summary = oneLine(product.description, 80);
			return `- [${product.name}](${SITE_URL}/products/${product.id})${price}${plans}${delivery}${summary ? `：${summary}` : ""}`;
		}),
		"",
	]);
	return [
		`# ${siteName}`,
		"",
		`> ${siteName}（${SITE_URL.replace("https://", "")}）是一家数字商品商城，主要销售 AI 会员充值（ChatGPT、Claude、Grok、Gemini 等）、Codex 点数额度和相关账号类商品。付款后 24 小时自动发放卡密，在订单页按提示兑换即可；会员充值类商品提供 30 天订阅质保。`,
		"",
		"## 在售商品",
		"",
		...catalog,
		...(guides.length
			? [
					"## 指南",
					"",
					...guides.map(
						(guide) =>
							`- [${guide.title}](${SITE_URL}/guides/${guide.slug})：${oneLine(guide.description, 120)}`,
					),
					"",
				]
			: []),
		"## 购买与交付",
		"",
		"- 下单：在商品页选择规格并付款，付款后在订单详情页查看交付结果。",
		"- 24 小时自动发货：付款成功后系统自动发放卡密，订单详情页会显示卡密和对应的充值地址。",
		"- 兑换方式：复制订单里的卡密，打开同一订单显示的充值地址，按页面提示填写账号信息并提交，等待充值完成。",
		"- 少数标注“人工采购”的商品：付款后把订单页显示的订单 CDK 发给在线客服，由客服完成充值。",
		"",
		"## 售后规则",
		"",
		"- 会员充值类商品提供 30 天订阅质保，质保期内订阅异常可在订单页申请售后。",
		"- 账号被封禁、多人共用同一账号、频繁更换 IP 或账号自身风控等原因不在售后范围。",
		"- 各规格的交付方式、覆盖与续费、质保和限制条款以商品页“规格说明”为准。",
		"- 售后与咨询：网页右下角“客服”在线联系，或 Telegram 客服 @laoshirenai_support_bot。",
		"",
		"## 主要页面",
		"",
		`- [首页与全部商品](${SITE_URL}/)`,
		`- [订单查询](${SITE_URL}/orders)：用订单号和下单邮箱查询订单、领取卡密`,
		`- [使用指南](${SITE_URL}/guides)`,
		...publicGuidePages.map(
			(guide) => `- [${guide.title}](${SITE_URL}${guide.path})`,
		),
		`- [站点地图](${SITE_URL}/sitemap.xml)`,
		"",
	].join("\n");
}

export function textResponse(body: string, contentType: string) {
	return new Response(body, {
		headers: {
			"content-type": contentType,
			"cache-control": "public, max-age=3600",
		},
	});
}
