-- Claude 专属环境 · 流量加购: production catalog rows (owner runs this once,
-- after the code that references these ids is deployed).
--
--   npx wrangler d1 execute DB --remote --file ops/claude-env-traffic-skus.sql
--
-- * Ids are the constants in src/features/claude-env/domain.ts
--   (claudeEnvTrafficProductId / claudeEnvTrafficSkus). Change both together.
-- * The product is unlisted in code (src/features/storefront/unlisted-products.ts):
--   never on the homepage, catalog, tag counts or sitemap; sold only from the
--   customer panel's 「加流量」 checkout links.
-- * fulfillment_source = 'manual' with no stock: checkout never runs out; the
--   claude-env cron raises the quota and marks the delivery completed itself.
--   email_mode = 'none' (the order page shows the result), renewal disabled.
-- * Currency must match the monthly Claude env SKU (CNY, 2 decimals): the
--   SELECT below inserts nothing otherwise — check the verification query.
-- * Idempotent: INSERT OR IGNORE. Prices are minor units (¥30 = '3000').
-- * cost_minor = IPRoyal add-on list price × 6.75 (estimate; real cost only if bought)
-- * (was: cost_minor is left NULL (IPRoyal extra-traffic cost is per purchase and
--   recorded by the buyer CLI); the sale alert then shows cost 待确认.

INSERT OR IGNORE INTO products
	(id, name, description, tag_names, product_type, status, sale_disabled, sort_order, created_at, updated_at)
VALUES (
	'e07fd8fc-5f0f-416e-9d85-382c091256a2',
	'Claude 专属环境 · 流量加购',
	'给正在使用的 Claude 专属环境加本期流量：100GB / 500GB / 1TB。只在当前 30 天流量周期内有效，到重置日清零，不累积到下一期；付款后立即生效。请在订单页「Claude 专属环境」里点「加流量」购买。',
	'[]',
	'stock',
	'active',
	0,
	99000,
	unixepoch() * 1000,
	unixepoch() * 1000
);

INSERT OR IGNORE INTO product_sellable_items
	(id, product_id, name, policy_json, renewal_mode, email_mode, show_on_order_page, allow_resend,
	 fulfillment_source, currency, currency_decimals, price_minor, cost_minor,
	 minimum_quantity, maximum_quantity, sort_order, enabled, sale_disabled, created_at, updated_at)
SELECT t.id, 'e07fd8fc-5f0f-416e-9d85-382c091256a2', t.name,
	json_object(
		'delivery', '付款后自动加到你的 Claude 专属环境本期流量里，订单页立即可见',
		'deliveryTime', '付款后 1 分钟内生效',
		'coverage', '只在当前 30 天流量周期内有效，到重置日清零，不累积到下一期',
		'warranty', '需要有正在使用的 Claude 专属环境',
		'restrictions', '仅限已开通 Claude 专属环境的登录用户购买；可以多次加购'
	),
	'disabled', 'none', 1, 0,
	'manual', m.currency, m.currency_decimals, t.price_minor, t.cost_minor,
	1, 1, t.sort_order, 1, 0, unixepoch() * 1000, unixepoch() * 1000
FROM (
	SELECT 'c3675807-27e7-4442-a820-e4016b8c0e37' AS id, '100GB（本期有效）' AS name, '3000' AS price_minor, '1688' AS cost_minor, 100 AS sort_order
	UNION ALL SELECT 'f1ea0f36-274a-414c-aa36-c6ebad153d3b', '500GB（本期有效）', '12900', '7931', 200
	UNION ALL SELECT 'f69b64f7-36dd-49e2-a07f-9df5a63fb4d2', '1TB（本期有效）', '22900', '14850', 300
) t
JOIN product_sellable_items m ON m.id = 'c3bab030-0c3c-4451-9c41-3cc32538e778'
WHERE m.currency = 'CNY' AND m.currency_decimals = 2;

-- Verification: expect 3 rows, CNY, manual, enabled, prices 3000 / 12900 / 22900.
SELECT s.id, s.name, s.currency, s.currency_decimals, s.price_minor, s.fulfillment_source,
	s.enabled, s.sale_disabled, p.status AS product_status
FROM product_sellable_items s JOIN products p ON p.id = s.product_id
WHERE s.product_id = 'e07fd8fc-5f0f-416e-9d85-382c091256a2'
ORDER BY s.sort_order;
