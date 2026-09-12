# AISOU manual restock eligibility

Manual replenishment and automatic upstream purchasing are separate operations.
The admin import uses the same eligibility rule as the AISOU inventory list:
active stock products with enabled items, backed either by an enabled SharedStock
binding for local fulfillment or by existing AISOU inventory (including legacy
source notes). An existing pool remains restockable when its purchasing binding
is disabled or absent. Import must never enable upstream purchasing.

The inventory-create permission and the shared restock API's encryption,
quantity bounds, duplicate rejection, idempotent receipt and atomic writes remain
unchanged. No migration is required.

Regression: seed one owned Plus card and disable its purchasing binding; the
list shows the pool and a 30-line import increases stock from 1 to 31. Also test
an existing pool without a binding and rejection of unrelated targets.

## 中文

手动补货与自动向上游采购是两个独立操作。补货入口与 AISOU 库存列表使用相同
的资格判断：商品有效、规格启用，且是有启用 SharedStock 绑定的本地规格，
或者已有 AISOU 库存（包括历史来源备注）。已有库存池在采购绑定关闭或移除后
仍可手动补货，不得因此开启自动采购。

库存新增权限、加密、数量限制、重复检测、幂等回执与原子写入均保持不变，
无需数据库迁移。回归覆盖关闭采购绑定时从 1 张补入 30 张变为 31 张、无绑定
的已有库存池，以及拒绝无关商品。
