# Stock fulfillment / 库存履约

## Modes

- `local`: deliver the stored CDK and recharge instructions. It does not purchase
  or automatically change source on shortage. Keep customer-code inventory aligned
  with prepaid upstream capacity, accounting for sold-but-unredeemed obligations.
- `supplier`: purchase from the enabled exact supplier binding and deliver that
  supplier's CDK with its verified recharge instructions. Dormant local cards and
  previously paid deliveries are not changed.
- Explicit local-first opt-in: `fulfillment.supplier_fallback.<item_id>` stores JSON
  `true`. A paid order reserves prepaid local cards FIFO, then creates one existing
  supplier order for only the deficit. Configure only the intended SKU; an enabled
  binding alone never authorizes purchasing in local mode.

The existing product-editor button switches the two manual modes. A manual
selection disarms automatic fallback, including when selecting the current mode.
It reuses checkout's stock, price, reserve-balance and purchasing-budget checks.
The switch itself never purchases, deletes stock or rewrites paid deliveries.

Explicitly enabled reseller export listings follow the selected mode, without
implicitly enabling exports or exposing the internal route to customers. Supplier
payment URLs are not recharge URLs. Unknown purchase results keep the existing
request identifier and reconciliation path; no blind repeat purchase is added.

## 中文

- 自有模式发库存中保存的 CDK 与充值地址；上游采购模式发对应上游返回的交付内容。
- 复用商品编辑页的切换按钮，不新增模式枚举、采购框架、轮询或自动切换任务。
- 只有明确配置的 SKU 才启用“预购库存优先、缺口采购”；手动切换后仅使用所选模式。
- 自有码数量不是上游履约能力，须扣除已售待兑义务后维护真实可售库存。
- 配置变更不得改写已售/已占用库存和历史交付；只有明确迁移的未售人工凭证退出可售库存。
- CDK 发货不代表客户账号已经激活或续费；真实交易验收需单独授权。

## Verification

Integration tests cover FIFO allocation, deficits, exact integer costs, concurrent
last-card claims, payment/purchase replay, source-specific recharge instructions,
manual-mode budget gates, policy disarming, reseller ordering and guarded config
changes. Synthetic configuration is in `tests/fixtures/owned-stock-mode-config.sql`;
production IDs, account records and deployment configuration are deliberately not
stored in this public repository.

The test fixture illustrates a renewal SKU with automatic deficit procurement and
two manually switched SKUs. Mutating each essential rule makes its corresponding
test fail. No new schema, queue, provider adapter or order state machine is added.

Before release run typecheck, tests, Biome, Workers and Bun builds. Validate the
product-editor controls on desktop/mobile and both locales/themes. Production
configuration and public readback are separate from source tests and builds.
