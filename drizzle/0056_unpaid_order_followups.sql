-- 未付款订单跟进邮件：每个过期未付订单最多一条记录（order_id 主键），重试永远不会重复发。
-- status：sending（已占位、正在入队）、sent（已入队，发送前还会再核一次资格）、skipped（按规则不发，
-- status_reason 写原因）、cancelled（入队后、交给邮件服务商前发现客户已付款/退订/功能已关，没发出）、
-- failed（入队结果不确定或失败，不再重发）。只存收件人邮箱哈希。activation_at 记下占位时的开启批次，
-- 关掉再开后，上一批排队的邮件不会再发。
-- 功能开关 notifications.unpaid_followup_enabled 默认关闭；开启时间之前创建的订单永远不发。
CREATE TABLE unpaid_order_followups (
 order_id TEXT PRIMARY KEY NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
 recipient_hash TEXT,
 status TEXT NOT NULL CHECK (status IN ('sending','sent','skipped','cancelled','failed')),
 status_reason TEXT,
 locale TEXT,
 product_id TEXT,
 sellable_item_id TEXT,
 usdt_hint INTEGER NOT NULL DEFAULT 0 CHECK (usdt_hint IN (0,1)),
 activation_at INTEGER,
 notification_delivery_id TEXT,
 sent_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX unpaid_order_followups_status_idx ON unpaid_order_followups(status, updated_at);
--> statement-breakpoint
-- 每个收件人（邮箱哈希）一行：30 天冷却的原子占位，和订单占位在同一个事务里写入。
-- 占位从不因为结果不确定而释放；30 天后可被新的订单覆盖。
CREATE TABLE unpaid_followup_recipients (
 recipient_hash TEXT PRIMARY KEY NOT NULL,
 order_id TEXT NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
 reserved_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX unpaid_followup_recipients_order_idx ON unpaid_followup_recipients(order_id);
--> statement-breakpoint
-- 资格检查按账号或邮箱找员工/代理身份，用索引代替每分钟全表扫描。
CREATE INDEX IF NOT EXISTS users_lower_email_idx ON users(lower(email));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_access_orders_user_idx ON agent_access_orders(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_access_orders_email_idx ON agent_access_orders(lower(trim(email)));
