-- 订单来源归因：在首次来源之外再记最近一次非直接来源（last-touch），并细分渠道。
-- 新分类：email（我们自己发的邮件链接，utm_medium=email）、referral（邀请链接 ?ref=INV-… 且无 utm）、
-- wechat_in_app / telegram_in_app / qq_in_app（无来源无 utm 时按内置浏览器 User-Agent 区分的“直接访问”）。
-- in_app_browser 是触点细节（wechat/telegram/qq），不是伪造的来源域名。last_* 为 NULL 表示下单时没有
-- 最近来源 cookie，报表回退到首次来源。重建表只为放宽 CHECK，已有数据原样复制。
CREATE TABLE `__new_order_attribution` (
	`order_id` text PRIMARY KEY NOT NULL,
	`source_category` text NOT NULL,
	`referrer_host` text,
	`utm_source` text,
	`utm_medium` text,
	`utm_campaign` text,
	`landing_path` text,
	`first_seen_at` integer,
	`in_app_browser` text,
	`last_source_category` text,
	`last_referrer_host` text,
	`last_utm_source` text,
	`last_utm_medium` text,
	`last_utm_campaign` text,
	`last_landing_path` text,
	`last_seen_at` integer,
	`last_in_app_browser` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `shop_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "order_attribution_category_check" CHECK("source_category" IN ('search','ai','social','email','referral','wechat_in_app','telegram_in_app','qq_in_app','direct','other','unknown')),
	CONSTRAINT "order_attribution_last_category_check" CHECK("last_source_category" IS NULL OR "last_source_category" IN ('search','ai','social','email','referral','wechat_in_app','telegram_in_app','qq_in_app','direct','other')),
	CONSTRAINT "order_attribution_in_app_check" CHECK("in_app_browser" IS NULL OR "in_app_browser" IN ('wechat','telegram','qq')),
	CONSTRAINT "order_attribution_last_in_app_check" CHECK("last_in_app_browser" IS NULL OR "last_in_app_browser" IN ('wechat','telegram','qq'))
);
--> statement-breakpoint
INSERT INTO `__new_order_attribution` (`order_id`, `source_category`, `referrer_host`, `utm_source`, `utm_medium`, `utm_campaign`, `landing_path`, `first_seen_at`, `created_at`)
SELECT `order_id`, `source_category`, `referrer_host`, `utm_source`, `utm_medium`, `utm_campaign`, `landing_path`, `first_seen_at`, `created_at` FROM `order_attribution`;
--> statement-breakpoint
DROP TABLE `order_attribution`;
--> statement-breakpoint
ALTER TABLE `__new_order_attribution` RENAME TO `order_attribution`;
