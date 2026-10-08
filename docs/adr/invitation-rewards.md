# Invitation rewards and personal recall coupons

Status: local implementation; production activation, issuance and email sending remain separately authorized.
Verification evidence is recorded under the task artifact directory, not as a production success claim.

## Contract

One existing coupon namespace. `standard` coupons retain their behavior; `referral`
uses a user's persistent code, `recall` binds a seven-day single-use code to one
registered user and campaign. Explicit codes override captured referral links.
No lifetime customer binding, new-customer detection, multilevel payouts or cash-out.
Only explicit per-SKU CNY budgets (0, 100, 200, 400, 800 minor units) participate.
An order caps its new buyer discount plus reward at 800 minor units. Referral
splits equally; recall gives the entire budget to the buyer and no reward.
Existing rewards are tender, not newly issued discounts.

Promotion, order creation, payment settlement, wallet reservation and refund are
public verification seams. Tests exercise these interfaces and actual temporary
D1, never real payments, stock procurement, emails or production credentials.

Reuse the coupon reservation lifecycle. Keep rewards distinct from cash and hold
both atomically for mixed payments. Capture only the external remainder. Expiry
releases holds; late external payments after release require reconciliation, not
free fulfillment. Refunds restore original tender without cashing out rewards.
Rewards mature at 00:00 Beijing time on the day after fulfillment and are reversed on refunds; spent
rewards create reward-only debt, never an unsolicited debit of cash balance.

Recall issuance is administrative and idempotent per campaign and customer. No
marketing send endpoint, automation or campaign engine is part of this change.

## Ablation

Keep: cap, exclusive mode, verified recipient, atomic coupon claim and tender
holds, immutable order snapshots, idempotency, refund source separation.
Remove: lifetime hierarchy, percentage commissions, withdrawal, generic rule
engine, automatic campaign sending, guest recall verification, duplicate wallet
framework. Extend existing feature modules directly.

## Worktree

Reused idle `fix-claude-pro-sale-capacity`; previous detached HEAD 929efb4 is
preserved in Git. Work branch `feat/invitation-rewards-20261007` starts at
ad7a35a (main, 1.22.5). Shared node_modules links and local data must be retained.

## Implementation ablation

Preview and checkout share the existing coupon loader, scope checks and one
pricing path. The separate preview SQL implementation was removed. Tests use
public pricing/checkout/payment/refund interfaces plus temporary D1 and Bun
SQLite. A copied-module mutation experiment keeps production source untouched:
baseline 5/5 passes; deleting the cap fails 2 tests; allowing recall rewards also
fails 2 tests. Those guards remain. No new dependency was installed.


## Next-day reward availability update

Rewards mature at 00:00 Asia/Shanghai on the calendar day after delivery, not after 24 hours. The existing minute scheduler performs settlement. Migration 0030 also shortens existing pending deadlines using the original deadline minus seven days; available/reversed rewards, null deadlines, cash balances and reward amounts are unchanged. The seven-day recall coupon lifetime and CNY 8 order budget remain unchanged. Customer introductory copy omits the budget cap; the backend/admin cap remains enforced. Copy feedback uses the existing toast and localized success/failure messages, only after the clipboard operation resolves.
