# SKU product links / 商品规格精确链接

Product links accept `?item=<sellable-item UUID>` and select that exact item on
load, even when it is sold out or sale-disabled. The existing purchase gates
still apply. Unknown valid UUIDs do not silently select another item. Links
without `item` keep the default selection; customers may still switch manually.
Navigating between item links resets selection and minimum quantity.

商品链接支持 `?item=<售卖项 UUID>`，打开即选中对应规格，缺货或禁售时也不替换
成别的规格，仍由原来的购买规则决定能否下单。不存在的有效 UUID 不会静默跳到
其他套餐。普通商品链接默认选择及用户手动切换行为保持不变。

Examples / 示例:
- iOS 20X: `/products/2a794b89-3bb9-49d4-8691-0d13a1606869?item=208c2e9c-3594-4be9-9c71-22ac8b09aad4`
- Pro 500: `/products/2a794b89-3bb9-49d4-8691-0d13a1606869?item=030582df-98c1-5b87-914d-28ddc606e163`

Regression coverage / 回归检查: exact initial selection, quantity, cart target,
ordinary links, manual switching, unknown item, and same-product navigation.
No pricing, inventory, fulfillment, authorization or schema change is included.

消融：只扩展原商品页输入与现有选择逻辑，没有新增路由、链接服务、状态抽象或数据库字段
