-- 支付宝订单码支付（alipay_qr）限额与超额拆单。
-- 渠道限额：单笔上限、单日上限（'0' = 不限），超过单笔上限时是否自动拆成多笔、最多拆几笔。
ALTER TABLE payment_channels ADD COLUMN split_enabled INTEGER NOT NULL DEFAULT 0 CHECK (split_enabled IN (0, 1));
--> statement-breakpoint
ALTER TABLE payment_channels ADD COLUMN per_payment_max_minor TEXT NOT NULL DEFAULT '0' CHECK (per_payment_max_minor <> '' AND per_payment_max_minor NOT GLOB '*[^0-9]*');
--> statement-breakpoint
ALTER TABLE payment_channels ADD COLUMN daily_max_minor TEXT NOT NULL DEFAULT '0' CHECK (daily_max_minor <> '' AND daily_max_minor NOT GLOB '*[^0-9]*');
--> statement-breakpoint
ALTER TABLE payment_channels ADD COLUMN split_max_parts INTEGER NOT NULL DEFAULT 10 CHECK (split_max_parts BETWEEN 2 AND 20);
--> statement-breakpoint
-- 拆单订单的整单付款记录（payment_attempts 一行，金额=整单）记下拆了几笔和各笔手续费之和；
-- 普通付款两列都是 NULL。provider_payment_id 是 'split:<付款记录id>'，不是支付宝交易号。
ALTER TABLE payment_attempts ADD COLUMN split_part_count INTEGER CHECK (split_part_count IS NULL OR split_part_count BETWEEN 2 AND 20);
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN processing_fee_minor TEXT CHECK (processing_fee_minor IS NULL OR (processing_fee_minor <> '' AND processing_fee_minor NOT GLOB '*[^0-9]*'));
--> statement-breakpoint
CREATE INDEX payment_attempts_channel_succeeded_idx ON payment_attempts(channel_id, succeeded_at);
--> statement-breakpoint
-- 每一笔子付款都是独立的支付宝交易（out_trade_no = 本行 id 去掉横线）。
CREATE TABLE payment_split_parts (
 id TEXT PRIMARY KEY NOT NULL,
 payment_attempt_id TEXT NOT NULL REFERENCES payment_attempts(id),
 channel_id TEXT NOT NULL REFERENCES payment_channels(id),
 part_index INTEGER NOT NULL,
 part_count INTEGER NOT NULL,
 amount_minor TEXT NOT NULL,
 provider_payment_id TEXT,
 provider_trade_no TEXT,
 checkout_url TEXT,
 notify_url TEXT NOT NULL,
 provider_expires_at INTEGER,
 status TEXT NOT NULL DEFAULT 'created',
 succeeded_at INTEGER,
 refunded_minor TEXT NOT NULL DEFAULT '0',
 failure_code TEXT,
 next_check_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CONSTRAINT payment_split_parts_index_check CHECK (part_index BETWEEN 1 AND part_count AND part_count BETWEEN 2 AND 20),
 CONSTRAINT payment_split_parts_amount_check CHECK (amount_minor <> '' AND amount_minor NOT GLOB '*[^0-9]*' AND amount_minor <> '0'),
 CONSTRAINT payment_split_parts_refunded_check CHECK (refunded_minor <> '' AND refunded_minor NOT GLOB '*[^0-9]*'),
 CONSTRAINT payment_split_parts_status_check CHECK (status IN ('created', 'pending', 'succeeded', 'failed', 'expired', 'closed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX payment_split_parts_attempt_index_uidx ON payment_split_parts(payment_attempt_id, part_index);
--> statement-breakpoint
CREATE UNIQUE INDEX payment_split_parts_channel_provider_uidx ON payment_split_parts(channel_id, provider_payment_id);
--> statement-breakpoint
CREATE INDEX payment_split_parts_channel_succeeded_idx ON payment_split_parts(channel_id, succeeded_at);
--> statement-breakpoint
CREATE INDEX payment_split_parts_status_updated_idx ON payment_split_parts(status, updated_at, id);
--> statement-breakpoint
CREATE INDEX payment_split_parts_status_check_idx ON payment_split_parts(status, next_check_at, updated_at, id);
--> statement-breakpoint
-- 子付款的原路退款：订单过期/取消时自动退已付的笔（refund_id 为空），或后台整单退款按笔拆开（refund_id 指向 refunds）。
-- id 去掉横线就是支付宝的 out_request_no，重试同一行不会重复退款。
CREATE TABLE payment_split_refunds (
 id TEXT PRIMARY KEY NOT NULL,
 part_id TEXT NOT NULL REFERENCES payment_split_parts(id),
 refund_id TEXT REFERENCES refunds(id),
 amount_minor TEXT NOT NULL,
 reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 attempt_count INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER,
 failure_code TEXT,
 alerted_at INTEGER,
 completed_at INTEGER,
 manual_reference TEXT,
 completed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CONSTRAINT payment_split_refunds_amount_check CHECK (amount_minor <> '' AND amount_minor NOT GLOB '*[^0-9]*' AND amount_minor <> '0'),
 CONSTRAINT payment_split_refunds_status_check CHECK (status IN ('pending', 'succeeded', 'failed', 'manual'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX payment_split_refunds_part_refund_uidx ON payment_split_refunds(part_id, refund_id) WHERE refund_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX payment_split_refunds_part_automatic_uidx ON payment_split_refunds(part_id) WHERE refund_id IS NULL;
--> statement-breakpoint
CREATE INDEX payment_split_refunds_status_next_idx ON payment_split_refunds(status, next_attempt_at, id);
--> statement-breakpoint
-- 价格联动：渠道 A 的 price_source_channel_id = 渠道 B 时，A 的渠道专属价永远等于 B 的。
-- B 的专属价增删改由下面的触发器同步到 A；直接把 A 改成与 B 不同的价格会被拒绝。
ALTER TABLE payment_channels ADD COLUMN price_source_channel_id TEXT REFERENCES payment_channels(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE TRIGGER sellable_item_channel_prices_linked_insert_guard
BEFORE INSERT ON sellable_item_channel_prices
WHEN EXISTS (SELECT 1 FROM payment_channels WHERE id = NEW.channel_id AND price_source_channel_id IS NOT NULL)
 AND NOT EXISTS (
  SELECT 1 FROM sellable_item_channel_prices source
  JOIN payment_channels linked ON linked.price_source_channel_id = source.channel_id
  WHERE linked.id = NEW.channel_id AND source.sellable_item_id = NEW.sellable_item_id
   AND source.price_minor = NEW.price_minor AND source.enabled = NEW.enabled)
BEGIN
 SELECT RAISE(ABORT, 'linked_channel_price_readonly');
END;
--> statement-breakpoint
CREATE TRIGGER sellable_item_channel_prices_linked_update_guard
BEFORE UPDATE ON sellable_item_channel_prices
WHEN EXISTS (SELECT 1 FROM payment_channels WHERE id = NEW.channel_id AND price_source_channel_id IS NOT NULL)
 AND NOT EXISTS (
  SELECT 1 FROM sellable_item_channel_prices source
  JOIN payment_channels linked ON linked.price_source_channel_id = source.channel_id
  WHERE linked.id = NEW.channel_id AND source.sellable_item_id = NEW.sellable_item_id
   AND source.price_minor = NEW.price_minor AND source.enabled = NEW.enabled)
BEGIN
 SELECT RAISE(ABORT, 'linked_channel_price_readonly');
END;
--> statement-breakpoint
CREATE TRIGGER sellable_item_channel_prices_link_after_insert
AFTER INSERT ON sellable_item_channel_prices
BEGIN
 INSERT INTO sellable_item_channel_prices
  (id, sellable_item_id, channel_id, price_minor, enabled, created_at, updated_at)
 SELECT NEW.id || ':' || linked.id, NEW.sellable_item_id, linked.id, NEW.price_minor,
  NEW.enabled, NEW.created_at, NEW.updated_at
 FROM payment_channels linked WHERE linked.price_source_channel_id = NEW.channel_id
 ON CONFLICT(sellable_item_id, channel_id) DO UPDATE SET price_minor = excluded.price_minor,
  enabled = excluded.enabled, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER sellable_item_channel_prices_link_after_update
AFTER UPDATE OF price_minor, enabled ON sellable_item_channel_prices
BEGIN
 INSERT INTO sellable_item_channel_prices
  (id, sellable_item_id, channel_id, price_minor, enabled, created_at, updated_at)
 SELECT NEW.id || ':' || linked.id, NEW.sellable_item_id, linked.id, NEW.price_minor,
  NEW.enabled, NEW.created_at, NEW.updated_at
 FROM payment_channels linked WHERE linked.price_source_channel_id = NEW.channel_id
 ON CONFLICT(sellable_item_id, channel_id) DO UPDATE SET price_minor = excluded.price_minor,
  enabled = excluded.enabled, updated_at = excluded.updated_at;
END;
--> statement-breakpoint
CREATE TRIGGER sellable_item_channel_prices_link_after_delete
AFTER DELETE ON sellable_item_channel_prices
BEGIN
 DELETE FROM sellable_item_channel_prices
 WHERE sellable_item_id = OLD.sellable_item_id
  AND channel_id IN (SELECT id FROM payment_channels WHERE price_source_channel_id = OLD.channel_id);
END;
