# 自有卡密库存与履约容量 / Owned inventory and fulfillment capacity

## 口径 / Definitions

- **自有卡密库存 / Owned code stock**: 当前 SKU 的 available stock_entries；不包括 reserved、delivered，不加供应商目录，不用中央凭证数替代。未售前台码是我们持有的交付库存，不是新增充值凭证。
- **上游可用凭证 / Owned upstream keys**: 中央仓可用凭证，另列 leased / processing。仅有明确 PH 转换路由的自有原始供应商卡可作为已持有凭证计入；不把未采购供应商卡计入。无法读取显示未知，不显示 0。
- **可采购 / Available to procure**: 仅纯 supplier 商品的采购能力；目录数量要经过快照有效性、渠道状态、价格上限、账户余额和保留余额、单单采购上限检查。共享钱包各 SKU 的能力不可相加。
- **下单容量 / Purchase capacity**: 不是展示库存。销售按自有兑换码库存预留；上游未占用凭证减已售未兑承诺仅用于履约风险诊断，不阻止发码。

## Behavior

1. Local SKUs display owned codes identically in storefront, supply console and supplier-export catalog. Existing agent/subsite mirrors synchronize this authoritative export; they must not sum mirrored stock into another pool.
2. Supplier-only SKUs retain automatic procurement. Their product option label is 可采购, not 库存. Mixed product-list cards display owned inventory separately from an automatic-procurement indicator.
3. Preissuing up to 100 codes per batch is independent of upstream inventory. Replaying the same batch reference returns the same codes. Preissuing neither reserves keys nor calls the provider.
4. Mapped central SKUs reserve owned customer codes atomically at checkout and supplier API order creation. Main and reseller orders share one code pool. Zero upstream capacity or an unavailable warehouse does not block code sale, payment, or delivery. Upstream stock is checked when the customer redeems. A transaction-local stock trigger rejects insufficient owned codes before payment; payment replay does not reserve twice and unpaid expiration/cancellation releases reservations.
5. Checkout never silently generates extra codes. Local products cannot accept new orders beyond owned code stock. Existing paid-order supplier fallback/recovery behavior is retained; supplier-only order placement still checks procurement balance and price.
6. Concurrent purchases cannot oversell owned codes. Existing upstream redemption/lease checks are unchanged. Exchange chains and paid-but-unallocated orders remain included in advisory capacity diagnostics; diagnostics do not gate order payment or delivery.

## Acceptance example

50 owned storefront codes + 2 upstream keys + 27 unpurchased supplier entries:
- owned stock and supplier-export stock: 50, never 77;
- upstream keys: 2; visible gap: 48;
- supplier directory quantity: 27, separately marked unpurchased;
- up to 50 customer codes can be sold and delivered; only 2 can currently redeem against held upstream keys, so upstream replenishment remains an independent operational obligation;
- preissuing 50 changes neither upstream count nor provider call count.

## Release boundary

Local implementation only. Requires coordinated review/release of GMShop and the redemption worker. Do not deploy or mutate production settings as part of testing. After a separately authorized release, synchronize existing agent mappings and verify public main/agent/subsite SKU readbacks. Tests use fake credentials, local databases and mocked providers only.

## 消融 / Ablation

Reuse stock_entries and existing order transactions; no new stock table, generic inventory service or duplicated pool. Capacity cache invalidation remains advisory; a narrow order-item insert trigger prevents code overselling. Remove checkout-time automatic code issuance, capacity-driven public stock substitution, supplier addition for local-stock display, and warehouse refresh calls from read-only catalog/cart rendering. Keep payment/refund semantics unchanged. Remove checkout/payment warehouse refreshes and upstream-budget predicates; keep owned-code reservation and replay safeguards.
