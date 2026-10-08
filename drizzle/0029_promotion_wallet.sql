ALTER TABLE users ADD COLUMN reward_balance_minor TEXT NOT NULL DEFAULT '0';
--> statement-breakpoint
CREATE TABLE reward_entries (
 id TEXT PRIMARY KEY NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 delta_minor TEXT NOT NULL,
 balance_after_minor TEXT NOT NULL,
 source_type TEXT NOT NULL CHECK (source_type IN ('earned','hold','release','refund','reversal')),
 source_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX reward_entries_user_created_idx ON reward_entries(user_id,created_at,id);
--> statement-breakpoint
CREATE TABLE order_balance_holds (
 order_id TEXT PRIMARY KEY NOT NULL REFERENCES shop_orders(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 cash_minor TEXT NOT NULL CHECK(cash_minor <> '' AND cash_minor NOT GLOB '*[^0-9]*'),
 reward_minor TEXT NOT NULL CHECK(reward_minor <> '' AND reward_minor NOT GLOB '*[^0-9]*'),
 external_minor TEXT NOT NULL CHECK(external_minor <> '' AND external_minor NOT GLOB '*[^0-9]*'),
 state TEXT NOT NULL DEFAULT 'held' CHECK(state IN ('held','consumed','released')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE promotion_rewards (
 order_id TEXT PRIMARY KEY NOT NULL REFERENCES shop_orders(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 amount_minor TEXT NOT NULL,
 remaining_minor TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','available','reversed')),
 available_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX promotion_rewards_settle_idx ON promotion_rewards(state,available_at,order_id);
--> statement-breakpoint
ALTER TABLE refunds ADD COLUMN cash_return_minor TEXT NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE refunds ADD COLUMN reward_return_minor TEXT NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE refunds ADD COLUMN referral_reversal_minor TEXT NOT NULL DEFAULT '0';
--> statement-breakpoint
CREATE TRIGGER order_balance_hold_validate BEFORE INSERT ON order_balance_holds BEGIN
 SELECT CASE WHEN NEW.state <> 'held' OR NOT EXISTS (
  SELECT 1 FROM shop_orders o JOIN users u ON u.id = NEW.user_id
  WHERE o.id = NEW.order_id AND o.user_id = NEW.user_id AND u.enabled = 1 AND o.status = 'pending_payment'
   AND o.currency = 'CNY' AND o.currency_decimals = 2 AND o.expires_at > NEW.created_at
   AND CAST(u.balance_minor AS INTEGER) >= CAST(NEW.cash_minor AS INTEGER)
   AND MAX(0,CAST(u.reward_balance_minor AS INTEGER)) >= CAST(NEW.reward_minor AS INTEGER)
   AND CAST(NEW.cash_minor AS INTEGER) + CAST(NEW.reward_minor AS INTEGER) + CAST(NEW.external_minor AS INTEGER) = CAST(o.total_minor AS INTEGER)
   AND NOT EXISTS (SELECT 1 FROM payment_attempts WHERE order_id = o.id)
 ) THEN RAISE(ABORT,'wallet_hold_conflict') END;
END;
--> statement-breakpoint
CREATE TRIGGER order_balance_hold_debit AFTER INSERT ON order_balance_holds BEGIN
 INSERT INTO wallet_entries(id,user_id,direction,amount_minor,balance_before_minor,balance_after_minor,currency,source_type,source_id,idempotency_key,reason,created_at)
 SELECT lower(hex(randomblob(16))), id,'debit',NEW.cash_minor,balance_minor,CAST(CAST(balance_minor AS INTEGER)-CAST(NEW.cash_minor AS INTEGER) AS TEXT),
  'CNY','shop_order',NEW.order_id,'balance-hold:'||NEW.order_id,'Reserved for order',NEW.created_at FROM users WHERE id=NEW.user_id AND CAST(NEW.cash_minor AS INTEGER)>0;
 UPDATE users SET balance_minor=CAST(CAST(balance_minor AS INTEGER)-CAST(NEW.cash_minor AS INTEGER) AS TEXT),
  reward_balance_minor=CAST(CAST(reward_balance_minor AS INTEGER)-CAST(NEW.reward_minor AS INTEGER) AS TEXT),balance_version=balance_version+1,updated_at=NEW.created_at WHERE id=NEW.user_id;
 INSERT INTO reward_entries SELECT lower(hex(randomblob(16))),id,CAST(-CAST(NEW.reward_minor AS INTEGER) AS TEXT),reward_balance_minor,'hold',NEW.order_id,'hold:'||NEW.order_id,NEW.created_at
  FROM users WHERE id=NEW.user_id AND CAST(NEW.reward_minor AS INTEGER)>0;
END;
--> statement-breakpoint
CREATE TRIGGER order_balance_hold_immutable BEFORE UPDATE ON order_balance_holds BEGIN
 SELECT CASE WHEN NEW.order_id<>OLD.order_id OR NEW.user_id<>OLD.user_id OR NEW.cash_minor<>OLD.cash_minor
  OR NEW.reward_minor<>OLD.reward_minor OR NEW.external_minor<>OLD.external_minor
  OR (NEW.state<>OLD.state AND (OLD.state<>'held' OR NEW.state NOT IN ('consumed','released')))
 THEN RAISE(ABORT,'wallet_hold_immutable') END;
END;
--> statement-breakpoint
CREATE TRIGGER order_balance_hold_release AFTER UPDATE OF state ON order_balance_holds WHEN OLD.state='held' AND NEW.state='released' BEGIN
 INSERT INTO wallet_entries(id,user_id,direction,amount_minor,balance_before_minor,balance_after_minor,currency,source_type,source_id,idempotency_key,reason,created_at)
 SELECT lower(hex(randomblob(16))),id,'credit',NEW.cash_minor,balance_minor,CAST(CAST(balance_minor AS INTEGER)+CAST(NEW.cash_minor AS INTEGER) AS TEXT),
  'CNY','adjustment',NEW.order_id,'balance-release:'||NEW.order_id,'Released order reserve',NEW.updated_at FROM users WHERE id=NEW.user_id AND CAST(NEW.cash_minor AS INTEGER)>0;
 UPDATE users SET balance_minor=CAST(CAST(balance_minor AS INTEGER)+CAST(NEW.cash_minor AS INTEGER) AS TEXT),
  reward_balance_minor=CAST(CAST(reward_balance_minor AS INTEGER)+CAST(NEW.reward_minor AS INTEGER) AS TEXT),balance_version=balance_version+1,updated_at=NEW.updated_at WHERE id=NEW.user_id;
 INSERT INTO reward_entries SELECT lower(hex(randomblob(16))),id,NEW.reward_minor,reward_balance_minor,'release',NEW.order_id,'release:'||NEW.order_id,NEW.updated_at
  FROM users WHERE id=NEW.user_id AND CAST(NEW.reward_minor AS INTEGER)>0;
END;
--> statement-breakpoint
CREATE TRIGGER order_balance_paid_guard BEFORE UPDATE OF status ON shop_orders WHEN NEW.status='paid' AND OLD.status<>'paid' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM order_balance_holds WHERE order_id=NEW.id AND state='released')
 THEN RAISE(ABORT,'payment_reconciliation_required') END;
END;
--> statement-breakpoint
CREATE TRIGGER order_balance_lifecycle AFTER UPDATE OF status ON shop_orders BEGIN
 UPDATE order_balance_holds SET state=CASE WHEN NEW.status='paid' THEN 'consumed' ELSE 'released' END,updated_at=NEW.updated_at
  WHERE order_id=NEW.id AND state='held' AND NEW.status IN ('paid','cancelled','expired');
 INSERT INTO promotion_rewards(order_id,user_id,amount_minor,remaining_minor,state,created_at,updated_at)
  SELECT NEW.id,NEW.referrer_user_id,NEW.referral_reward_minor,NEW.referral_reward_minor,'pending',NEW.updated_at,NEW.updated_at
  WHERE NEW.status='paid' AND NEW.promotion_purpose='referral' AND CAST(NEW.referral_reward_minor AS INTEGER)>0
  ON CONFLICT(order_id) DO NOTHING;
 UPDATE promotion_rewards SET available_at=COALESCE(available_at,NEW.updated_at+604800000),updated_at=NEW.updated_at
  WHERE order_id=NEW.id AND NEW.status='completed';
END;
--> statement-breakpoint
CREATE TRIGGER promotion_reward_credit AFTER UPDATE OF state ON promotion_rewards WHEN OLD.state='pending' AND NEW.state='available' BEGIN
 UPDATE users SET reward_balance_minor=CAST(CAST(reward_balance_minor AS INTEGER)+CAST(NEW.remaining_minor AS INTEGER) AS TEXT),updated_at=NEW.updated_at WHERE id=NEW.user_id;
 INSERT INTO reward_entries SELECT lower(hex(randomblob(16))),id,NEW.remaining_minor,reward_balance_minor,'earned',NEW.order_id,'earned:'||NEW.order_id,NEW.updated_at FROM users WHERE id=NEW.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER mixed_payment_failure_release AFTER UPDATE OF status ON payment_attempts
WHEN NEW.status IN ('failed','expired') AND OLD.status IN ('created','pending') BEGIN
 UPDATE order_balance_holds SET state='released',updated_at=NEW.updated_at WHERE order_id=NEW.order_id AND state='held';
 UPDATE shop_orders SET status='cancelled',cancelled_at=NEW.updated_at,updated_at=NEW.updated_at,version=version+1
  WHERE id=NEW.order_id AND status='pending_payment' AND EXISTS(SELECT 1 FROM order_balance_holds WHERE order_id=NEW.order_id AND state='released');
END;

--> statement-breakpoint
CREATE TRIGGER promotion_refund_insert AFTER INSERT ON refunds WHEN NEW.status='succeeded' BEGIN

 INSERT INTO wallet_entries(id,user_id,direction,amount_minor,balance_before_minor,balance_after_minor,currency,source_type,source_id,idempotency_key,reason,created_at)
 SELECT lower(hex(randomblob(16))),u.id,'credit',NEW.cash_return_minor,u.balance_minor,CAST(CAST(u.balance_minor AS INTEGER)+CAST(NEW.cash_return_minor AS INTEGER) AS TEXT),
  'CNY','refund',NEW.id,'balance-refund:'||NEW.id,'Original balance returned',NEW.updated_at FROM users u JOIN shop_orders o ON o.user_id=u.id
  WHERE o.id=NEW.order_id AND CAST(NEW.cash_return_minor AS INTEGER)>0;
 UPDATE users SET balance_minor=CAST(CAST(balance_minor AS INTEGER)+CAST(NEW.cash_return_minor AS INTEGER) AS TEXT),
  reward_balance_minor=CAST(CAST(reward_balance_minor AS INTEGER)+CAST(NEW.reward_return_minor AS INTEGER) AS TEXT),balance_version=balance_version+1,updated_at=NEW.updated_at
  WHERE id=(SELECT user_id FROM shop_orders WHERE id=NEW.order_id) AND (CAST(NEW.cash_return_minor AS INTEGER)>0 OR CAST(NEW.reward_return_minor AS INTEGER)>0);
 INSERT INTO reward_entries SELECT lower(hex(randomblob(16))),u.id,NEW.reward_return_minor,u.reward_balance_minor,'refund',NEW.id,'refund:'||NEW.id,NEW.updated_at
  FROM users u JOIN shop_orders o ON o.user_id=u.id WHERE o.id=NEW.order_id AND CAST(NEW.reward_return_minor AS INTEGER)>0;
 UPDATE users SET reward_balance_minor=CAST(CAST(reward_balance_minor AS INTEGER)-CAST(NEW.referral_reversal_minor AS INTEGER) AS TEXT),updated_at=NEW.updated_at
  WHERE id=(SELECT user_id FROM promotion_rewards WHERE order_id=NEW.order_id AND state='available') AND CAST(NEW.referral_reversal_minor AS INTEGER)>0;
 INSERT INTO reward_entries SELECT lower(hex(randomblob(16))),u.id,CAST(-CAST(NEW.referral_reversal_minor AS INTEGER) AS TEXT),u.reward_balance_minor,'reversal',NEW.id,'reversal:'||NEW.id,NEW.updated_at
  FROM users u JOIN promotion_rewards r ON r.user_id=u.id WHERE r.order_id=NEW.order_id AND r.state='available' AND CAST(NEW.referral_reversal_minor AS INTEGER)>0;
 UPDATE promotion_rewards SET remaining_minor=CAST(MAX(0,CAST(remaining_minor AS INTEGER)-CAST(NEW.referral_reversal_minor AS INTEGER)) AS TEXT),
  state=CASE WHEN CAST(remaining_minor AS INTEGER)<=CAST(NEW.referral_reversal_minor AS INTEGER) THEN 'reversed' ELSE state END,updated_at=NEW.updated_at
  WHERE order_id=NEW.order_id AND CAST(NEW.referral_reversal_minor AS INTEGER)>0;
END;

--> statement-breakpoint
CREATE TRIGGER promotion_refund_update AFTER UPDATE OF status ON refunds WHEN NEW.status='succeeded' AND OLD.status<>'succeeded' BEGIN

 INSERT INTO wallet_entries(id,user_id,direction,amount_minor,balance_before_minor,balance_after_minor,currency,source_type,source_id,idempotency_key,reason,created_at)
 SELECT lower(hex(randomblob(16))),u.id,'credit',NEW.cash_return_minor,u.balance_minor,CAST(CAST(u.balance_minor AS INTEGER)+CAST(NEW.cash_return_minor AS INTEGER) AS TEXT),
  'CNY','refund',NEW.id,'balance-refund:'||NEW.id,'Original balance returned',NEW.updated_at FROM users u JOIN shop_orders o ON o.user_id=u.id
  WHERE o.id=NEW.order_id AND CAST(NEW.cash_return_minor AS INTEGER)>0;
 UPDATE users SET balance_minor=CAST(CAST(balance_minor AS INTEGER)+CAST(NEW.cash_return_minor AS INTEGER) AS TEXT),
  reward_balance_minor=CAST(CAST(reward_balance_minor AS INTEGER)+CAST(NEW.reward_return_minor AS INTEGER) AS TEXT),balance_version=balance_version+1,updated_at=NEW.updated_at
  WHERE id=(SELECT user_id FROM shop_orders WHERE id=NEW.order_id) AND (CAST(NEW.cash_return_minor AS INTEGER)>0 OR CAST(NEW.reward_return_minor AS INTEGER)>0);
 INSERT INTO reward_entries SELECT lower(hex(randomblob(16))),u.id,NEW.reward_return_minor,u.reward_balance_minor,'refund',NEW.id,'refund:'||NEW.id,NEW.updated_at
  FROM users u JOIN shop_orders o ON o.user_id=u.id WHERE o.id=NEW.order_id AND CAST(NEW.reward_return_minor AS INTEGER)>0;
 UPDATE users SET reward_balance_minor=CAST(CAST(reward_balance_minor AS INTEGER)-CAST(NEW.referral_reversal_minor AS INTEGER) AS TEXT),updated_at=NEW.updated_at
  WHERE id=(SELECT user_id FROM promotion_rewards WHERE order_id=NEW.order_id AND state='available') AND CAST(NEW.referral_reversal_minor AS INTEGER)>0;
 INSERT INTO reward_entries SELECT lower(hex(randomblob(16))),u.id,CAST(-CAST(NEW.referral_reversal_minor AS INTEGER) AS TEXT),u.reward_balance_minor,'reversal',NEW.id,'reversal:'||NEW.id,NEW.updated_at
  FROM users u JOIN promotion_rewards r ON r.user_id=u.id WHERE r.order_id=NEW.order_id AND r.state='available' AND CAST(NEW.referral_reversal_minor AS INTEGER)>0;
 UPDATE promotion_rewards SET remaining_minor=CAST(MAX(0,CAST(remaining_minor AS INTEGER)-CAST(NEW.referral_reversal_minor AS INTEGER)) AS TEXT),
  state=CASE WHEN CAST(remaining_minor AS INTEGER)<=CAST(NEW.referral_reversal_minor AS INTEGER) THEN 'reversed' ELSE state END,updated_at=NEW.updated_at
  WHERE order_id=NEW.order_id AND CAST(NEW.referral_reversal_minor AS INTEGER)>0;
END;
--> statement-breakpoint
ALTER TABLE payment_attempts ADD COLUMN order_amount_minor TEXT;
--> statement-breakpoint
CREATE TRIGGER payment_funding_snapshot_guard BEFORE INSERT ON payment_attempts WHEN NEW.order_id IS NOT NULL BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM order_balance_holds h WHERE h.order_id=NEW.order_id
  AND (h.state<>'held' OR NEW.order_amount_minor IS NOT h.external_minor))
 THEN RAISE(ABORT,'payment_funding_changed') END;
END;
--> statement-breakpoint
CREATE TRIGGER mixed_payment_single_attempt_guard BEFORE INSERT ON payment_attempts
WHEN EXISTS(SELECT 1 FROM order_balance_holds WHERE order_id=NEW.order_id) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM payment_attempts WHERE order_id=NEW.order_id
  AND idempotency_key<>NEW.idempotency_key AND status IN ('created','pending','succeeded'))
 THEN RAISE(ABORT,'payment_attempt_already_active') END;
END;
--> statement-breakpoint
CREATE INDEX promotion_rewards_user_created_idx ON promotion_rewards(user_id,created_at,order_id);
--> statement-breakpoint
CREATE TRIGGER mixed_payment_receipt_guard BEFORE UPDATE OF status ON shop_orders
WHEN NEW.status='paid' AND OLD.status<>'paid' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM order_balance_holds WHERE order_id=NEW.id AND state='held' AND CAST(external_minor AS INTEGER)>0)
  AND NOT EXISTS(SELECT 1 FROM payment_attempts WHERE order_id=NEW.id AND status='succeeded')
 THEN RAISE(ABORT,'external_payment_required') END;
END;
