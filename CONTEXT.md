# Inventory language

- 自有卡密库存 / Owned code stock: the shop's unreserved, unsold delivery codes for one SKU.
- 上游可用凭证 / Owned upstream keys: already-held, usable recharge credentials, not supplier listings.
- 供应商可采购量 / Supplier catalogue quantity: supplier-reported units not yet owned by the shop.
- 可采购 / Available to procure: verified automatic-procurement capability for supplier-only products; not owned stock.
- 下单容量 / Purchase capacity: owned customer-code stock available for sale; upstream fulfillment headroom is separate advisory telemetry, not a sale/payment/delivery gate.
- 库存镜像 / Stock mirror: another shop's view of the same underlying pool, not additional inventory.
