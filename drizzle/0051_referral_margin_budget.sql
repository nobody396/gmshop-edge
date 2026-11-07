-- Invitation budget per SKU, recomputed every minute from price and real cost
-- (35% of the thinnest channel margin, whole yuan). Recall coupons keep using
-- promotion_budget_minor; a SKU joins invitations only while that is above 0.
ALTER TABLE product_sellable_items ADD COLUMN referral_budget_minor TEXT NOT NULL DEFAULT '0'
 CHECK(referral_budget_minor <> '' AND referral_budget_minor NOT GLOB '*[^0-9]*');
