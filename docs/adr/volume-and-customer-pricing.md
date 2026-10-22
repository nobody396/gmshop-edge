# 批量拿货、阶梯价与客户专属价（2026-10-22）

## 价格

- **公开阶梯价**：`sellable_item_volume_prices`，买到 `min_quantity` 张起，每张在当前付款方式的价格上减
  `discount_minor`。USDT、支付宝、余额都减同样的金额，所以定价守护改原价时阶梯价跟着动。
- **客户专属价**：`customer_item_prices`，按注册用户。`price_minor` 是基准价（USDT/余额）；支付宝付
  基准价 + 这个规格平时的支付宝差价，`channel_prices_json` 里点名的渠道价优先。`min_quantity = 1` 是一口价。
  专属价不跟定价守护变。
- **结算**：`resolveUnitPrice`（`src/features/storefront/volume-pricing.ts`）在原价、阶梯价、专属价里取最低，
  下单时服务端算定并快照到 `shop_order_items.unit_price_minor` / `price_source`（list | volume | customer）。
  商品页、购物车、结算页通过 `quoteCheckoutUnitPricesFn` / `getProductPricingFn` 用同一函数显示。
- **优惠券**只作用于按原价的行；全部是阶梯价/专属价的订单用券会被拒（`coupon_not_combinable`）。

## 设置入口

- 后台 **客户增长 → 批量价与专属价**（`/admin/pricing`）：增删阶梯价、增删客户专属价。
- 老板 Telegram 通知群（只认群主，先出确认卡片，点确认才生效）：
  - `/vip [邮箱]`：查看
  - `/vipprice 邮箱 商品 [N张起] 价格[/支付宝价]`：例 `/vipprice a@b.com Plus菲区 10张起 113`
  - `/vipdel 邮箱 商品 [N张起]`
- 每天北京时间 09:30 后检查一次：专属价按当前进价亏钱时，发「上调到 进价+设价时的利润 / 保持不变」按钮；
  同一进价只提醒一次。

## 批量进货（AISOU）

1. 一行卖出 ≥3 张兑换站自有卡密：交付后 `recordBulkSale` 记一条 `bulk_procurements`（每行一次）。
2. 每分钟 `runBulkProcurements` 调兑换站 `POST /api/internal/aisou/bulk`（见兑换站 `docs/aisou-bulk.md`），
   兑换站负责报价、库存、余额检查、一次下单、验卡、绑定卡密，同一批次只会下单一次。
3. 结果都发 Telegram：
   - 已进货（验卡中）→ 验卡完成 / 需人工核对
   - 余额不够：写明还差多少，按钮「已充值，重新进货」
   - AISOU 缺货：不进货，按钮「已补货，重新进货」
   - 报价高于公布的批发价：按钮「按 ¥x/张进货」
   - 每条都有「这批不进了」：之后客户兑一张单买一张
   - 订单在进货前退款：取消，不进货
4. 有阶梯价且接了兑换站的规格，自有卡密少于 100 张时每 10 分钟最多自动补到 150 张
   （`topUpBulkCodeStock`）。卡密不花钱，兑换时才进货。

当前开放：ChatGPT Plus 菲区（10/30/40/50 张起减 1/2/3/4 元）、Pro 100 菲区（3 张起减 5）、Pro 100 智利（减 3）、
Pro 200 菲区新开/续费（减 10）、Pro 500 智利（减 21）；一单最多 50 张。
