const SUPPLIER_SNAPSHOT_MAX_AGE_MS = 30 * 60_000;

// Explicit per-SKU opt-in: local-only items must never spend supplier balance.
export function supplierFallbackEnabledExpression(itemAlias: string) {
	return `EXISTS (SELECT 1 FROM system_settings setting
  WHERE setting.key = 'fulfillment.supplier_fallback.' || ${itemAlias}.id
   AND setting.value = 'true')`;
}

// Accept paid orders for an explicitly opted-in SKU before funding its supplier.
// Procurement keeps its independent live balance and spending checks.
export function supplierUnfundedCheckoutExpression(itemIdExpression: string) {
	return `EXISTS (SELECT 1 FROM system_settings setting
  WHERE setting.key = 'fulfillment.supplier_unfunded_checkout.' || ${itemIdExpression}
   AND setting.value = 'true')`;
}

export function storefrontStockExpression(
	productAlias: string,
	itemAlias: string,
) {
	const syncedSupplierStock =
		storefrontSyncedSupplierStockExpression(itemAlias);
	const localStock = `(
		 SELECT COUNT(*) FROM stock_entries secret
		 WHERE secret.sellable_item_id = ${itemAlias}.id
		  AND secret.status = 'available'
		)`;
	return `CASE
		WHEN ${productAlias}.product_type <> 'stock' THEN -1
		WHEN ${itemAlias}.fulfillment_source = 'manual' THEN -1
        WHEN ${itemAlias}.fulfillment_source = 'supplier' THEN ${syncedSupplierStock}
		ELSE ${localStock}
	END`;
}

export function storefrontSyncedSupplierStockExpression(itemAlias: string) {
	return `COALESCE((
			SELECT MIN(binding.stock_quantity, COALESCE((SELECT MAX(
      CASE WHEN CAST(binding.reference_cost_minor AS INTEGER) > 0 THEN
       CASE WHEN ${supplierUnfundedCheckoutExpression(`${itemAlias}.id`)} THEN
        COALESCE(CAST(account.max_order_cost_minor AS INTEGER) / CAST(binding.reference_cost_minor AS INTEGER), binding.stock_quantity)
       ELSE MAX(0, MIN(CAST(account.balance_minor AS INTEGER)-CAST(account.reserve_balance_minor AS INTEGER),
        COALESCE(CAST(account.max_order_cost_minor AS INTEGER),CAST(account.balance_minor AS INTEGER)))) / CAST(binding.reference_cost_minor AS INTEGER) END
       ELSE 0 END)
     FROM supplier_accounts account WHERE account.provider=binding.provider
      AND account.normalized_api_origin=binding.normalized_api_origin AND account.protocol_version=binding.protocol_version
      AND account.enabled=1 AND account.health_status <> 'unavailable'
      AND (account.cooldown_until IS NULL OR account.cooldown_until <= unixepoch()*1000)
      AND account.balance_minor IS NOT NULL),0))
			FROM supplier_bindings binding
			WHERE binding.sellable_item_id = ${itemAlias}.id
			 AND binding.enabled = 1
			 AND binding.remote_status = 'active'
			 AND binding.last_synced_at >= (unixepoch() * 1000 - ${SUPPLIER_SNAPSHOT_MAX_AGE_MS})
			 AND (
			  length(binding.reference_cost_minor) < length(binding.max_cost_minor)
			  OR (
			   length(binding.reference_cost_minor) = length(binding.max_cost_minor)
			   AND binding.reference_cost_minor <= binding.max_cost_minor
			  )
			 )
			LIMIT 1
		), 0)`;
}

export { SUPPLIER_SNAPSHOT_MAX_AGE_MS };

// A product-card summary, not a purchasing budget. Supplier variants share a
// wallet: use the largest individually verified quantity, never sum that wallet
// multiple times. Independent owned SKU code pools can be added normally.
export function storefrontCatalogStockExpression(
	productAlias: string,
	itemAlias: string,
) {
	const stock = storefrontStockExpression(productAlias, itemAlias);
	return `COALESCE(SUM(CASE WHEN ${itemAlias}.fulfillment_source='local' THEN ${stock} ELSE 0 END),0)
  + COALESCE(MAX(CASE WHEN ${itemAlias}.fulfillment_source='supplier' THEN ${stock} ELSE 0 END),0)`;
}
