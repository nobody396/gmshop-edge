# AISOU PH owned-code delivery without stopping sales

## Minimal cutover boundary

Keep the current local stock and supplier purchasing paths. No second inventory pool, generic router, storefront pause, price change or procurement enablement is introduced.

A `delivery_records.redeem_sku` snapshot captures a route setting atomically when the delivery record is created. Existing records stay NULL and retain their original delivery, including 86. Route choices are restricted to GPT_PLUS_PH, GPT_5X_PH and GPT_20X_PH and validated against the exact live PH item name.

- Global setting: `integration.redeem_delivery.<component-id>`.
- Single unpaid-order trial: `integration.redeem_delivery_trial.<order-id>.<component-id>`; it takes priority only for that order.
- Trial requires one unpaid item, quantity one, and no existing delivery; the final D1 transaction repeats the pending/no-delivery guard. A payment winning the race retains its old snapshot.
- A durable replay receipt prevents retrying an old enable request from undoing a later rollback.

## Delivery conversion

Both local allocation and supplier purchase responses already converge on reserved `stock_entries`. The existing common delivery worker converts a snapshotted PH row before publishing delivery:

1. Read the reserved original encrypted content.
2. Call the central conversion API with stable `gmstock-<stock-id>`, exact PH SKU and hidden upstream key.
3. Central D1 atomically verifies/imports, issues one local code, and binds the key/code/source reference uniquely. Replays must match SKU and key hash. Bound keys are excluded from generic reservation and issuable capacity; exchange transfers the binding and expired leases do not erase ownership.
4. CAS the reserved source row for the same order and fingerprint to encrypted owned CDK + owned URL, atomically setting `stock_entries.redeem_sku`.
5. Preserve original fingerprint (upstream re-import dedup), cost and procurement source. Never restore raw content after conversion.
6. Only finalize delivery when the order is paid/fulfilling and the complete quantity is still reserved with the correct converted SKU. A failed finalization guard aborts the entire D1 batch before stock/outbox/entitlement writes.

Conversion errors retain the original reservation and existing queue retries; they never fall back to raw delivery or restart supplier procurement. Partially converted multi-card orders reuse persisted converted rows. A corrupt converted marker fails closed. Legacy manual/raw repair endpoints cannot override a PH owned-delivery snapshot.

## Operations and rollback

`/api/ops/redeem-cutover` uses the existing RESTOCK_API_TOKEN bearer authorization; credentials are supplied only through Agent Switch, never embedded in a URL or this document.

POST body contains componentId, sku, enabled, requestRef, optional dryRun, and optional trialOrderNumber. `dryRun:true` requires enabled:true and returns before routing/receipt/audit mutation; it checks only internal API capability/SKU metadata, without reading or submitting any stock key. Enabling requires central API version 1 and the target SKU in the internal catalog. It does not sample/decrypt/verify a real card or require physical stock. Actual card validation occurs only as part of normal authorized order fulfillment, never as an agent-run acceptance test.

Rollback only changes future routing. Existing snapshots continue their assigned route; converted stock/code bindings are retained. Do not turn off the central AIEE service while issued local codes remain outstanding. Original orders may still deliver original material: they are an explicit compatibility exception, not a retroactive white-label migration.

## Low-cost acceptance and records

Real GUI/Session/CDK acceptance belongs exclusively to the owner. The agent performs code review and synthetic tests only: no real-key checks, account creation, customer selection, purchases or recharges. The owner may choose one Plus trial; this is not a prerequisite for completing code validation. Select the exact new order BEFORE payment; other orders remain on the old route. Customers enter their own Session on the controlled redemption page. Never collect Session in chat, audit logs, or files.

Correlate shop order → delivery → stock UUID → central conversion → local code ID → redemption attempt request ID. Store stage, timestamp, HTTP status, duration, byte count, classified error, request shape, Session length and HMAC fingerprint, not raw Session/Cookie/key/verification URL. Source failures persist in audit logs; central stage summaries are bounded and retain initial steps plus latest status fields. Logs support diagnosis and safe status readback, not a promise that every failure can be resolved without a new Session or further testing.

## 中文

不停卖，不提前搬走可售库存，也不改采购开关。新订单在原流程分配库存/采购回卡后、真正交付前，才把这张卡转入中央仓库并换成自家 CDK。现有订单和 86 保持原路由。

支持仅指定一笔尚未付款的 Plus 单件订单试运行；付款抢先则拒绝修改，不回填旧发货记录。全局切换和回滚仅影响之后生成的发货快照。已转换内容不还原原卡；失败不降级原卡直发、不重复采购。

来源库存保留原指纹、采购来源及成本；转换标记与新密文原子写入。收尾必须确认订单仍有效、整单库存仍归本订单，失败时整个收尾事务回滚，不消耗库存、不激活权益、不发送发货事件。

实卡验收由老板自行操作，可选择只测 Plus；5X/20X 只报告代码和模拟结果，不声称已实卡验证。不把真实卡验收或库存样本检查作为代码完成的前提，不擅自采购、替客户测试或充值。配置 dryRun 只验证内部 API 能力和 SKU，不读取任何库存卡。
