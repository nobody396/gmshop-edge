CREATE TABLE gpt_upgrade_orders (
 order_item_id TEXT PRIMARY KEY NOT NULL REFERENCES shop_order_items(id),
 quote_id TEXT NOT NULL,
 active_key TEXT UNIQUE,
 quote_token_encrypted TEXT NOT NULL,
 price_minor TEXT NOT NULL CHECK(price_minor <> '' AND price_minor NOT GLOB '*[^0-9]*' AND price_minor <> '0'),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','needs_review','cancelled')),
 status_url TEXT,
 error_code TEXT,
 attempt_count INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX gpt_upgrade_orders_retry_idx ON gpt_upgrade_orders(state,next_attempt_at);
--> statement-breakpoint
-- Seed only on the laoshirenvip.com catalog (it has the ChatGPT membership product); a fresh
-- installation gets the table but no upgrade product. Never renumber other products.
INSERT INTO products(id,name,description,product_type,status,sort_order)
SELECT '10000000-0000-4000-8000-000000000001','ChatGPT 会员升级（补差价）',
 '已有 ChatGPT Plus / Pro（网页订阅）可以直接补差价升级到 Pro 100 / Pro 200 / Pro 500，原账号不变。先在兑换站粘贴登录信息查价，付款后自动升级，一般 1–10 分钟完成。苹果 / 谷歌商店订阅、Go 会员暂不支持。本次只补升级差价，不包含以后的续费。',
 'automation','active',
 -- Right after the ChatGPT membership product when that slot is free (else its next free gap); never renumber others.
 COALESCE((SELECT MIN(p.sort_order + 1) FROM products p
   WHERE p.sort_order >= COALESCE((SELECT sort_order FROM products WHERE id='2a794b89-3bb9-49d4-8691-0d13a1606869'), 0)
     AND NOT EXISTS (SELECT 1 FROM products n WHERE n.sort_order=p.sort_order+1)),100)
WHERE EXISTS (SELECT 1 FROM products WHERE id='2a794b89-3bb9-49d4-8691-0d13a1606869');
--> statement-breakpoint
INSERT INTO product_sellable_items(id,product_id,name,price_minor,currency,currency_decimals,renewal_mode,email_mode,allow_resend,minimum_quantity,maximum_quantity)
SELECT '10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','按报价补差价','0','CNY',2,'disabled','link',1,1,1
WHERE EXISTS (SELECT 1 FROM products WHERE id='10000000-0000-4000-8000-000000000001');
