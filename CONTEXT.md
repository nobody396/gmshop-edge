# Inventory language

- 自有卡密库存 / Owned code stock: the shop's unreserved, unsold delivery codes for one SKU.
- 上游可用凭证 / Owned upstream keys: already-held, usable recharge credentials, not supplier listings.
- 供应商可采购量 / Supplier catalogue quantity: supplier-reported units not yet owned by the shop.
- 可采购 / Available to procure: verified automatic-procurement capability for supplier-only products; not owned stock.
- 下单容量 / Purchase capacity: owned customer-code stock available for sale; upstream fulfillment headroom is separate advisory telemetry, not a sale/payment/delivery gate.
- 库存镜像 / Stock mirror: another shop's view of the same underlying pool, not additional inventory.

## Unfunded supplier checkout (explicit per-SKU opt-in)

`system_settings["fulfillment.supplier_unfunded_checkout.<sellable_item_id>"] = true`
lets that supplier-only SKU display upstream stock and accept orders despite an
insufficient cached procurement balance. Default is false. Stock freshness,
active binding, cost ceiling, enabled/healthy account, cooldown and per-order
spending limits still apply. Payment and supplier fulfillment remain unchanged:
live insufficient funds prevent an upstream charge and leave a failed supplier
order for operator handling (fund account and reselect/retry). Never fabricate
supplier balance or stock. Turn the setting off to restore funded-capacity gating.

运营：此开关只放开指定 SKU 的采购余额售前限制，不保证即时交付；上游缺货、
失效、超成本或账号不可用仍禁止下单。实扣前余额保护不变，失败单仍须人工处理。
本次仅授权启用 SuperGrok Heavy 1个月，不影响其他规格或自有库存。
