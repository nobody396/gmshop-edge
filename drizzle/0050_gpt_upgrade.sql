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
-- Insert in an available sorting gap AFTER an existing product, never renumber others.
-- With no gap, append; on an empty installation use the normal default.
INSERT INTO products(id,name,description,product_type,status,sort_order)
SELECT '10000000-0000-4000-8000-000000000001','ChatGPT 会员升级（补差价）',
 '先在兑换站查价 → 付款 → 自动升级。支持 Plus / Pro 网页订阅升级到 Pro 100 / Pro 200 / Pro 500；苹果 / 谷歌商店订阅不能升级。金额以兑换站报价为准，规格价格 0 仅为占位，不代表免费。',
 'automation','active',COALESCE((SELECT MIN(p.sort_order + 1) FROM products p WHERE NOT EXISTS (SELECT 1 FROM products n WHERE n.sort_order=p.sort_order+1)),100);
--> statement-breakpoint
INSERT INTO product_sellable_items(id,product_id,name,price_minor,currency,currency_decimals,renewal_mode,email_mode,allow_resend,minimum_quantity,maximum_quantity)
VALUES ('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','按报价补差价','0','CNY',2,'disabled','link',1,1,1);
