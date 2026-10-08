-- Preserve ledger behavior; change only when delivery rewards become eligible.
-- Unix milliseconds, UTC+8, calendar-day boundary (not a rolling 24-hour delay).
DROP TRIGGER order_balance_lifecycle;
--> statement-breakpoint
CREATE TRIGGER order_balance_lifecycle AFTER UPDATE OF status ON shop_orders BEGIN
 UPDATE order_balance_holds SET state=(CASE WHEN NEW.status='paid' THEN 'consumed' ELSE 'released' END),updated_at=NEW.updated_at
  WHERE order_id=NEW.id AND state='held' AND NEW.status IN ('paid','cancelled','expired');
 INSERT INTO promotion_rewards(order_id,user_id,amount_minor,remaining_minor,state,created_at,updated_at)
  SELECT NEW.id,NEW.referrer_user_id,NEW.referral_reward_minor,NEW.referral_reward_minor,'pending',NEW.updated_at,NEW.updated_at
  WHERE NEW.status='paid' AND NEW.promotion_purpose='referral' AND CAST(NEW.referral_reward_minor AS INTEGER)>0
  ON CONFLICT(order_id) DO NOTHING;
 UPDATE promotion_rewards SET available_at=COALESCE(available_at,(CAST((NEW.updated_at + 28800000) / 86400000 AS INTEGER) + 1) * 86400000 - 28800000),updated_at=NEW.updated_at
  WHERE order_id=NEW.id AND NEW.status='completed';
END;
--> statement-breakpoint
-- Only unsettled rewards have their old seven-day deadline shortened.
-- available_at - 604800000 is the original completion time; updated_at may
-- already reflect a later partial refund and must not restart the waiting period.
UPDATE promotion_rewards
SET available_at = (CAST((available_at - 604800000 + 28800000) / 86400000 AS INTEGER) + 1) * 86400000 - 28800000
WHERE state = 'pending' AND available_at IS NOT NULL;
