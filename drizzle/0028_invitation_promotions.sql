ALTER TABLE product_sellable_items ADD COLUMN promotion_budget_minor TEXT NOT NULL DEFAULT '0' CHECK (promotion_budget_minor IN ('0','100','200','400','800'));
--> statement-breakpoint
ALTER TABLE coupons ADD COLUMN purpose TEXT NOT NULL DEFAULT 'standard' CHECK (purpose IN ('standard','referral','recall'));
--> statement-breakpoint
ALTER TABLE coupons ADD COLUMN referrer_user_id TEXT REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE coupons ADD COLUMN recipient_user_id TEXT REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE coupons ADD COLUMN campaign_key TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX coupons_referrer_uidx ON coupons(referrer_user_id) WHERE purpose = 'referral';
--> statement-breakpoint
CREATE UNIQUE INDEX coupons_recall_campaign_user_uidx ON coupons(campaign_key, recipient_user_id) WHERE purpose = 'recall';
--> statement-breakpoint
ALTER TABLE shop_orders ADD COLUMN promotion_purpose TEXT CHECK (promotion_purpose IN ('referral','recall'));
--> statement-breakpoint
ALTER TABLE shop_orders ADD COLUMN referrer_user_id TEXT REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE shop_orders ADD COLUMN referral_reward_minor TEXT NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE shop_order_items ADD COLUMN referral_reward_minor TEXT NOT NULL DEFAULT '0';
--> statement-breakpoint
CREATE TRIGGER coupons_promotion_insert_guard BEFORE INSERT ON coupons WHEN NEW.purpose <> 'standard' BEGIN
 SELECT CASE WHEN NEW.currency <> 'CNY' OR NEW.currency_decimals <> 2 OR NEW.type <> 'fixed'
  OR (NEW.purpose = 'referral' AND (NEW.referrer_user_id IS NULL OR NEW.recipient_user_id IS NOT NULL))
  OR (NEW.purpose = 'recall' AND (NEW.recipient_user_id IS NULL OR NEW.referrer_user_id IS NOT NULL OR NEW.campaign_key IS NULL
   OR NEW.usage_limit IS NOT 1 OR NEW.ends_at IS NULL OR NEW.starts_at IS NULL OR NEW.ends_at <= NEW.starts_at OR NEW.ends_at - NEW.starts_at > 604800000))
 THEN RAISE(ABORT, 'promotion_coupon_invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER coupons_promotion_update_guard BEFORE UPDATE ON coupons WHEN OLD.purpose <> 'standard' OR NEW.purpose <> 'standard' BEGIN
 SELECT CASE WHEN NEW.purpose <> OLD.purpose OR NEW.referrer_user_id IS NOT OLD.referrer_user_id
  OR NEW.recipient_user_id IS NOT OLD.recipient_user_id OR NEW.campaign_key IS NOT OLD.campaign_key
  OR NEW.type <> OLD.type OR NEW.currency IS NOT OLD.currency OR NEW.currency_decimals IS NOT OLD.currency_decimals
  OR NEW.value_minor IS NOT OLD.value_minor OR NEW.starts_at IS NOT OLD.starts_at OR NEW.ends_at IS NOT OLD.ends_at
  OR NEW.usage_limit IS NOT OLD.usage_limit OR NEW.code <> OLD.code
 THEN RAISE(ABORT, 'promotion_coupon_immutable') END;
END;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN marketing_consent INTEGER NOT NULL DEFAULT 0 CHECK(marketing_consent IN (0,1));
--> statement-breakpoint
CREATE TRIGGER personal_coupon_reservation_guard BEFORE INSERT ON coupon_redemptions
WHEN EXISTS (SELECT 1 FROM coupons WHERE id = NEW.coupon_id AND purpose = 'recall') BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM coupons c JOIN users u ON u.id = c.recipient_user_id
  WHERE c.id = NEW.coupon_id AND u.id = NEW.user_id AND u.enabled = 1 AND u.email_verified = 1
   AND c.enabled = 1 AND c.ends_at > NEW.created_at AND c.starts_at <= NEW.created_at)
  OR EXISTS (SELECT 1 FROM coupon_redemptions WHERE coupon_id = NEW.coupon_id AND status IN ('reserved','consumed'))
 THEN RAISE(ABORT, 'coupon_recipient_or_usage_invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER referral_coupon_reservation_guard BEFORE INSERT ON coupon_redemptions
WHEN EXISTS (SELECT 1 FROM coupons WHERE id=NEW.coupon_id AND purpose='referral') BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM coupons c JOIN users u ON u.id=c.referrer_user_id
  WHERE c.id=NEW.coupon_id AND c.enabled=1 AND u.enabled=1 AND u.id IS NOT NEW.user_id
   AND lower(u.email)<>lower(NEW.normalized_email)) THEN RAISE(ABORT,'referral_owner_invalid') END;
END;
--> statement-breakpoint
CREATE TRIGGER personal_coupon_late_payment_guard BEFORE UPDATE OF status ON shop_orders
WHEN NEW.status='paid' AND OLD.status<>'paid' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM coupon_redemptions cr JOIN coupons c ON c.id=cr.coupon_id
  WHERE cr.order_id=NEW.id AND c.purpose='recall' AND cr.status='released')
 THEN RAISE(ABORT,'payment_reconciliation_required') END;
END;
--> statement-breakpoint
CREATE INDEX coupons_recipient_expiry_idx ON coupons(recipient_user_id,ends_at) WHERE purpose='recall';
--> statement-breakpoint
CREATE TRIGGER promotion_coupon_release AFTER UPDATE OF status ON shop_orders
WHEN OLD.status='pending_payment' AND NEW.status IN ('cancelled','expired') BEGIN
 UPDATE coupons SET used_count=MAX(0,used_count-1),updated_at=NEW.updated_at
  WHERE purpose IN ('referral','recall') AND id IN (SELECT coupon_id FROM coupon_redemptions WHERE order_id=NEW.id AND status='reserved');
 UPDATE coupon_redemptions SET status='released',released_at=NEW.updated_at,updated_at=NEW.updated_at
  WHERE order_id=NEW.id AND status='reserved' AND coupon_id IN (SELECT id FROM coupons WHERE purpose IN ('referral','recall'));
END;
