-- Synthetic activation fixture only. Never apply this file to production.
-- Run all statements in one D1 batch for the integration test,
-- fresh exact-SKU supplier sync. No real purchase or deployment is performed.
-- Renewal: prepaid AISOU cards first, automatic deficit purchase.
-- Claude Pro / Go: manual local/supplier switch; keep their existing codes.
-- No order, payment, purchase, stock content, price or export switch is changed.
SELECT CASE WHEN (
 SELECT COUNT(*) FROM product_sellable_items item JOIN supplier_bindings binding
 ON binding.sellable_item_id=item.id
 WHERE item.enabled=1 AND item.fulfillment_source IN ('local','supplier')
 AND binding.provider='shared_stock' AND binding.normalized_api_origin='https://supplier.example'
 AND binding.protocol_version='acg-sharedstock-v1'
 AND binding.upstream_product_id=binding.upstream_sku_id
 AND (
  (item.id='11111111-1111-4111-8111-111111111111' AND item.name='Claude Pro 1个月'
   AND binding.id='44444444-4444-4444-8444-444444444444' AND binding.upstream_sku_id='fixture-claude') OR
  (item.id='22222222-2222-4222-8222-222222222222' AND item.name='ChatGPT Go 1个月'
   AND binding.id='55555555-5555-4555-8555-555555555555' AND binding.upstream_sku_id='fixture-go') OR
  (item.id='33333333-3333-4333-8333-333333333333' AND item.name='ChatGPT Pro 20X 菲区续费1个月'
   AND binding.id='66666666-6666-4666-8666-666666666666' AND binding.upstream_sku_id='fixture-renewal')
 )
 AND binding.enabled=1 AND binding.remote_status='active'
 AND NOT EXISTS (SELECT 1 FROM supplier_bindings other
  WHERE other.sellable_item_id=item.id AND other.enabled=1 AND other.id<>binding.id)
 AND binding.last_synced_at >= unixepoch()*1000-1800000
 AND (length(binding.reference_cost_minor)<length(binding.max_cost_minor)
  OR (length(binding.reference_cost_minor)=length(binding.max_cost_minor)
   AND binding.reference_cost_minor<=binding.max_cost_minor))
)=3 THEN 1 ELSE json_extract('fallback_exact_binding_not_ready','$') END;
--> statement-breakpoint
-- Only UNSOLD renewal manual vouchers stop being offered. Preserve redeemed,
-- delivered, reserved records and every Claude Pro / Go code.
UPDATE stock_entries SET status='disabled',updated_at=unixepoch()*1000
WHERE sellable_item_id='33333333-3333-4333-8333-333333333333'
 AND procurement_source='owner-generated-manual-voucher'
 AND status='available' AND order_item_id IS NULL;
--> statement-breakpoint
INSERT INTO system_settings(key,value,updated_at)
SELECT 'fulfillment.supplier_fallback.' || id,
 CASE WHEN id='33333333-3333-4333-8333-333333333333' THEN 'true' ELSE 'false' END,unixepoch()*1000
FROM product_sellable_items
WHERE id IN ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333')
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;

--> statement-breakpoint
-- Fixture guide for the renewal SKU, not new activation.
UPDATE product_sellable_items SET fulfillment_source='local',supplier_status=NULL,policy_json=json_set(policy_json,
 '$.delivery','付款后交付充值卡密，请按订单交付内容中的充值地址使用；卡密发货不代表账号已续费。',
 '$.deliveryTime','请按充值页面提示操作，到账及续费结果以账号实际状态为准。',
 '$.restrictions','仅限当前套餐为 Pro、账单为 PHP 8,919.64 的菲律宾区账号续费，不支持升级；请勿公开卡密。',
 '$.supplierUsageGuide',json('{"provider":"shared_stock","origin":"https://supplier.example","skuId":"fixture-renewal","url":"https://redeem.example/","verifiedSource":"fixture renewal description"}')
),updated_at=unixepoch()*1000 WHERE id='33333333-3333-4333-8333-333333333333';
