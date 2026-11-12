-- 未付款订单跟进邮件：每个过期未付订单最多一条记录（order_id 主键），重试永远不会重复发。
-- status：sending（已占位、正在入队）、sent（已入队发信）、skipped（按规则不发，status_reason 写原因）、
-- failed（占位后卡住超时，不再重发）。只存收件人邮箱哈希，用于「30 天内收过就不再发」。
-- 功能开关 notifications.unpaid_followup_enabled 默认关闭；开启时间之前创建的订单永远不发。
CREATE TABLE unpaid_order_followups (
 order_id TEXT PRIMARY KEY NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
 recipient_hash TEXT,
 status TEXT NOT NULL CHECK (status IN ('sending','sent','skipped','failed')),
 status_reason TEXT,
 locale TEXT,
 product_id TEXT,
 sellable_item_id TEXT,
 usdt_hint INTEGER NOT NULL DEFAULT 0 CHECK (usdt_hint IN (0,1)),
 notification_delivery_id TEXT,
 sent_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX unpaid_order_followups_recipient_idx ON unpaid_order_followups(recipient_hash, sent_at);
--> statement-breakpoint
CREATE INDEX unpaid_order_followups_status_idx ON unpaid_order_followups(status, updated_at);
