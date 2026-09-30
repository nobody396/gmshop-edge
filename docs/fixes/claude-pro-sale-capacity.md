# Claude Pro: sale capacity / 真实可售容量

## Contract / 口径

- Own customer codes are a delivery pool, not purchased inventory. Preissuing 50 or 100 does not occupy upstream stock.
- `sellable = max(0, upstream free keys - unleased, unassigned sold obligations)`.
- The warehouse free-key count already excludes leased/submitting/processing and independently assigned keys. Do not subtract those obligations twice.
- Follow exchanged codes to the latest leaf and deduplicate by exact code hash / leaf ID. Unknown hashes or unresolvable chains fail closed.
- Checkout temporarily holds capacity before payment. Payment/fulfillment preserves that hold; expiry/cancellation releases undelivered holds once. Delivered codes remain obligations until redemption completes or their replacement/refund chain is confirmed voided.
- 本次仅修复 `CLAUDE_PRO_IOS`；其他 SKU、PH 原卡转码、Aisou 与人工交付策略不变。

## Implementation / 实现

`redeem_sale_capacity` is a short-lived, versioned D1 read budget, not a second inventory source. GMShop submits only actually reserved/delivered code hashes to the internal warehouse API. It never submits raw codes or upstream credentials. D1 stock-change triggers debit one unit per newly allocated code inside the checkout transaction and reject negative/stale budgets. Version checks prevent an earlier network read from overwriting a concurrent allocation. The same budget is used by storefront, supplier export and supply management. If the code pool is smaller than verified capacity, checkout creates only the missing owned codes on demand.

Local APIs: `POST /api/internal/inventory/sale-capacity` on the redemption Worker (internal bearer authorization required); no upstream recharge/check request is made by this read endpoint.

## Verification / 验证

- Supply console regression reproduces old result 3 when upstream=3 and owed=2; corrected result is 1.
- Five keys, two sales, two further sales => one additional sale, even with 100 unused owned codes.
- Concurrent main/agent orders, payment/replay, code-pool refill, expired/cancelled orders and warehouse failure use real Miniflare D1 transactions.
- Warehouse tests cover processing without double subtraction, exchanged-code deduplication, completion, confirmed void/refund, unknown hashes and authorization.
- No production deployment, payment, customer notification, stock correction or manual recharge is performed by this implementation task.

## Release requirements / 发布前提

Deploy the redemption read endpoint before applying GMShop migration `0020_redeem_sale_capacity.sql` and deploying GMShop. This ordering is documentation, not authorization to deploy. Existing unrelated checkout/worktree changes are preserved. Legacy direct upstream-card deliveries are outside this central own-code pool.

## Frontend QA / 界面验证

The Browser plugin was not available; the installed agent-browser (Playwright-backed) CLI was used without installing browser dependencies. An isolated Vite fixture rendered the actual SupplyConsolePage component, not an authenticated production admin page. Desktop Chinese/light (1280x720) and mobile English/dark (390x844) rendered sale capacity 4, upstream free 6, owned-code pool 5 and obligations 2. Expand and refresh actions worked; keyboard Tab reached the SKU control. No app console errors or framework overlay remained; mobile viewport had no horizontal page overflow. The temporary fixture/browser/server were removed/stopped afterward. Authenticated production rendering remains unverified until an authorized deployment.

Local screenshot evidence:
- /Users/fujunhao/laoshirenai/local/qa/claude-sale-capacity/desktop-zh.png
- /Users/fujunhao/laoshirenai/local/qa/claude-sale-capacity/mobile-en-dark.png

## Ablation / 消融

Reuse the existing stock entries, code issuance and payment allocation flow. The sole added D1 table is a bounded versioned budget, with triggers for atomic debit/invalidation; no new supplier/router/general repository layer. Code generation fills only an actual shortfall, not a mandatory 50/100 batch. Already-held payments and unrelated SKU payments skip warehouse network refreshes. No background job or production data rewrite was added.

## Final validation / 最终验证

- GMShop: strict typecheck passed; 1,247 Vitest tests plus 23 Bun runtime tests passed, with one pre-existing skipped file and two pre-existing TODOs. Biome checked 912 files. Both Workers and Bun production builds passed.
- Redemption: typecheck, 24 tests, build and all three existing integration flows passed (86 baseline with/without AIEE and AIEE flow).
- Empty-D1 migration/install checks passed after updating the explicit migration list and table count for the one new budget table.
- Live read-only replay of the exact warehouse capacity SQL matched 24 actually sold/held code roots, with six free keys and two unleased outstanding obligations: four additional sales. No production write was used to calculate this.
- Both new worktrees are retained for the un-deployed repair. The prior main-checkout App/styles and AGENTS changes remain untouched; temporary browser/test servers are stopped.
