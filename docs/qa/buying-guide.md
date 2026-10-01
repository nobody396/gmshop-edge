# VIP buying guide — local review only

## Scope and implementation
- One fixed branch resolver and one React dialog, six retail families; no API, agent, uncertain-answer, AI or generic workflow services.
- Reuses Paraglide, existing product API/cache keys, currency formatting and Radix dialogs. No dependencies, migration, account-data upload or production writes.
- Keeps the user-provided annotated images unchanged. Examples enlarge inside a nested dialog, with fit/original-size toggle and a keyboard-scrollable image region. Closing returns to the current answer step. Only external account/billing checking links open a new tab.
- Result reads current product/variant availability and policies; no automatic cart/checkout. Exact `?item=UUID#purchase-options` link selects that option in the product page, including when unavailable; a removed requested option does not silently fall back to another option.
- Owner-confirmed Philippine Plus → Pro 5X difference-upgrade route remains unavailable until the new product exists. No guessed price or expiry date.
- Account state is not inferred from dates. Unverified downgrade combinations stop without a product link. The owner removed the ChatGPT payment-warning question; a matching current Pro $200/PHP 8,919.64 bill offers the dedicated renewal SKU or an explicitly selected iOS overwrite path. Claude requires an ended paid subscription; Max requires acknowledgement of self-managed KYC. Free accounts cannot buy Codex credits.
- Explicit verified public SKU policy mapping, not string matching or historical chat recommendations. Per owner review, all ChatGPT results except the standalone Philippine 20X renewal point to variants of product 2a794b89-3bb9-49d4-8691-0d13a1606869. The guide reads current enabled/sale-disabled and stock state; it never changes those flags.

## Ablation
- Removed a separate copy-accessor file and kept its small localized label map in the component; no extra module layer.
- Removed redundant first-screen description and changed the six family choices to two columns on mobile to reduce scrolling.
- Mutated pending-upgrade stop to regular 5X: regression tests failed, then restored.
- Removed stock gate: regression tests failed, then restored.
- Removed overwrite-consent gate: regression tests failed, then restored.
- Retained the locale resolver and exact-SKU selection because removing them changes correctness. The opening qualification check was retired in the 2026-10-01 owner review below.

## Tests and evidence
- Focused tests cover full reachable fixed tree, both-language key coverage, safe image/account links, nested image modal state preservation, pending product, stock/disabled/missing variant, back navigation and consent reset.
- Browser checks: correct 5X SKU selected after confirmation/link; no console errors in that flow. Desktop/mobile, English/Chinese and light/dark results recorded during local QA.
- Preview at http://localhost:4173/ uses isolated local SQLite fixture data. Prices and inventory are demonstrations, not live prices. Payment/email/bot providers are absent. No real purchase or email was triggered.
- Runtime fixture directory: /Users/fujunhao/laoshirenai/local/buying-guide-preview
- Screenshot directory: /Users/fujunhao/laoshirenai/local/buying-guide-preview/screenshots
- Requires owner review before deployment. No production deployment was performed.

## Final readback
- 18 buying-guide focused tests passed, including both image dialogs, zoom toggle and return-to-step state.
- Full Vitest run: 241 files / 1271 tests passed, one old homepage source-shape assertion failed because the existing guide is now preceded by BuyingGuide. Updated that assertion to assert both components, in order, under the same no-filter guard, then reran the affected suite plus all guide tests.
- Workers and Bun builds passed. Typecheck and Biome passed (one pre-existing informational template-literal suggestion in Telegram bot code).
- Desktop Chinese/dark, English/light, 390px and 320px checked. The 320px zoomed image scrolls inside a 244px region (natural width 3490px) without increasing page width; closing preserved the account question and URL.
- No live deployment or customer messages. New difference-upgrade product remains pending; unverified downgrade combinations remain blocked.

## Review update: one homepage card
Merged the standalone guide banner into the existing self-service recharge card. BuyingGuide now owns only its trigger/dialog; SelfServiceRecharge owns the sole card/section. The trigger is beside the short selection prompt under the main heading, while the original three steps remain unchanged. No new props, wrapper component, branch rules or data requests. Updated the existing homepage regression to require one section, one guide trigger and all three steps; the 20 related tests passed.

## Review update: channel, period and destinations
Owner-confirmed store routing copy classifies Apple/iOS as the US channel in this store. ChatGPT overwrite copy now explicitly starts a new 30-day period after CDK top-up success, with no remaining-day accumulation; the separate X/Grok overwrite copy is unchanged. Removed the payment-warning step and its unused translations, stop reason and answer state. Added exhaustive GPT destination assertions and a four-answer maximum in the fixed-tree test. No production state or sale flags were changed.

## 2026-10-01 owner review: dollar tiers and opened Pro 500
- Reused `feat/storefront-buying-guide` in the existing `claude-kyc-highlight` worktree; preserved and backed up the prior nine-file WIP before editing. No new branch/worktree/dependency was added.
- Targets now read Pro $100/$200/$500 rather than GPT 5X/20X. Pro $500 targets exact Chile item `030582df-98c1-5b87-914d-28ddc606e163` under the existing ChatGPT product; it is not an iOS product. Existing paid subscriptions cannot use that no-coverage channel; the 2–3 day mobile expiry condition remains visible.
- Free → Pro $200 goes directly to PH item `0829de43-da22-420c-9866-38c83dd420f0`, without an opening-qualification or clickable-upgrade check. Go/Plus → $200 retains iOS overwrite consent. Matching Pro/PHP 8,919.64 renewal retains its separate exact SKU.
- Incorporated the already-deployed eligibility removal from `558925f` without replacing the newer exact-SKU product page changes. Removed unreachable qualification branch/help/translations/component. Preserved the source image. Reused the existing standard delivery-time constant instead of adding another delivery abstraction.
- Owner separately authorized immediate live Pro $500 copy correction. D1 policy delivery/deliveryTime were copied exactly from the PH $200 item: `付款确认后在线处理` and the existing 1–30 minute / peak maximum 3 hour text. Removed pending-channel copy. Bumped product revision/cache token and wrote audits. Readback preserved IDs, price, enabled flags, coverage and warranty. Public selected item shows the corrected text and an enabled Buy button. No payment, recharge or customer notification was executed; actual recharge is not verified here.
- Live copy backups: `/Users/fujunhao/laoshirenai/local/buying-guide-preview/pro500-copy-before-20261001.json` and `pro500-standard-delivery-before-20261001.json`. Pre-existing WIP backup: `backup-20261001/pre-existing.patch` plus source files; SQLite backed up with SQLite's backup API before local fixture updates.
- Focused final regression: 5 files / 32 tests passed, covering the finite decision tree, both message catalogs, removed qualification, exact $500 links, active-subscription stop, stock/sale-disabled/missing variants, overwrite consent reset, nested image state preservation, homepage entry, English dollar-tier names and standardized delivery.
- Typecheck and Biome passed; Biome has one unrelated pre-existing informational suggestion in Telegram bot code. Workers and Bun builds were run. Full-suite Vitest attempts produced only their startup banner and did not finish; stopped only this worktree's attempts. The other worktree's tests were left untouched. Do not report the full suite as passed.
- Local browser: `http://localhost:4173/`, isolated SQLite fixture only. Chinese Free → $200 matched PH immediately; Free → $500 showed the opened exact SKU, live-copy-compatible delivery timing and purchase link. 390px check had page width 379px with no horizontal overflow. Page identity and content correct; no framework overlay or console errors/warnings in these flows.
- Buying-guide application changes remain local and undeployed. Production contains the separate owner-authorized metadata corrections only. Any eventual application release must reconcile latest source baseline plus the deployed `558925f`; do not overwrite unrelated current inventory/backend fixes with this older branch.

- Final additional browser readback: English/light Plus → Pro $200 selected the iOS item and required overwrite consent; keyboard Space unlocked the exact `208c2e9c-3594-4be9-9c71-22ac8b09aad4` link. Chinese/dark Free → Pro $500 remained available with correct delivery timing. No console errors/warnings. Both final Workers/Bun builds passed. Preview process retained intentionally for owner review; dependency symlink verified through its final target. No new worktree/branch to remove.
- Owner browser comment follow-up: target-option label is now `Pro 500美元档` / `Pro $500 tier`, with no region suffix. Only the option labels changed; exact SKU mappings, result product names and purchase conditions are unchanged. Two guide suites / 23 tests, typecheck, focused Biome, Workers and Bun builds passed. Refreshed local browser shows all three dollar tiers with no console warnings/errors. Existing worktree and dependency target retained for ongoing review; no branch/worktree created or removed.


## Intent and eligible-channel review
- Replaced the automatic paid-plan → iOS and Free → PH shortcuts with a minimal fixed resolver; no state-machine library, pricing guesses, migrations, new dependencies, or extra product requests.
- Current ChatGPT plans are Free, Go, Plus, Pro $100/$200/$500. Only paid accounts are asked `Recharge now` versus `Wait until my subscription ends`. Waiting is terminal and has no product request/link; the account must actually show Free before ordinary PH new activation is recommended. Existing subscription dates do not determine status.
- Free → Plus/$100/$200 offers both PH and iOS. Users can inspect a result's current price/conditions and go back to switch; the guide does not silently select the cheaper channel. Go and $500 have only one route, so no redundant channel question is added.
- Paid Plus → Plus first asks timing. Explicit now uses iOS overwrite, explains why ordinary PH cannot cover an active subscription, and retains the final overwrite acknowledgement. The new period is 30 days and does not stack remaining days.
- Current Pro $200 + PHP 8,919.64: explicitly select dedicated PH renewal or iOS overwrite. Current Pro $100 cannot be classified as that special renewal. Verified same-tier Pro $100 uses the current iOS overwrite policy; unverified downgrades remain blocked.
- PH Plus → $100: after identifying the PHP bill, explicitly choose the pending difference-upgrade path or iOS overwrite. Pending path never substitutes an ordinary recharge SKU; choosing iOS is a separate acknowledged overwrite operation. No purchase was performed.
- Ablation: removed redundant expiry prose from the current-plan description, preserved one resolver and existing dialogs/cache. Skipped channel questions when only one current route is eligible. Three temporary mutations (remove timing question, force Free to PH, collapse Pro tiers) each failed regressions; restored the final source before validation.
- Final validation: 5 focused suites / 40 tests passed, including exhaustive reachable paths with a six-answer maximum, both-language copy, intent gates, channel selection, matching renewal, pending upgrade, overwrite consent/reset, nested image preservation, missing/disabled/zero-stock gates and unchanged other retail families. Typecheck, Biome, Workers build and Bun build passed. One unrelated pre-existing informational Biome suggestion remains. Full-suite integration was not rerun because another worktree's Miniflare-backed full suite was already active; no other task's process was interrupted. Prior full-suite attempts were incomplete, not passed.
- Native browser QA via Codex in-app browser (CUA): localhost:4173; Chinese/dark desktop 1144×984, English/light, mobile 390×844. Mobile document width 379 and dialog width/scroll-width 377/377, no horizontal overflow. Keyboard Space confirmed overwrite before exposing the exact Plus iOS link. Verified Plus waiting has no purchase link, Free PH/iOS links differ exactly, and dedicated renewal points to the standalone PHP renewal product.

| Browser check | Result |
| --- | --- |
| URL/title | Correct localhost preview |
| Nonblank app | Homepage and guide meaningful |
| Framework error overlay | None |
| Console warnings/errors | None in validated final flows |
| Screenshot evidence | plus-renewal-intent.png, free-plus-channel-choice.png, free-plus-channel-mobile.png, pro200-renew-channel-choice.png, plus-renewal-intent-en-light.png |
| Interaction proof | Timing, wait, channels, exact links and keyboard acknowledgement verified |

- Final readback: rebuilt and restarted only the task's local preview process; returned it to Chinese/dark at Plus → Plus → timing choice and kept the tab visible for owner review. No application deployment or production metadata write in this review. Runtime fixture, existing branch/WIP and dependency symlink retained for ongoing review; pre-review backup is `backup-intent-review/before.patch`. No new worktree or branch was created; no unrelated worktree was cleaned up.

## Start-button breathing follow-up
- Scope is the existing `开始选择` / `Get started` trigger only. Added one class and one CSS keyframe; no wrapper, timer, animation dependency, translation or routing change. The latest discussed routing policy still needs to be reconciled before release; this visual follow-up is not routing acceptance or deployment authorization.
- 2.8s ease-in-out loop, scale 1 → 1.04 → 1, primary-color halo 0 → 7px → 0. CSS runs only with `prefers-reduced-motion: no-preference` and while the trigger is not hovered, keyboard-focused or open. Existing focus ring remains intact.
- Ablation/minimality: reused the existing primary color and Radix data-state; no extra React state/effect or JavaScript animation loop. No need to animate the entire card or add another call-to-action.
- Focused final regression: 5 suites / 44 tests passed. Typecheck, Biome, Workers and Bun builds passed; the same unrelated informational Biome note remains. Full-suite tests were not rerun for this animation-only follow-up; the preceding bounded run timed out and is not a pass.
- Browser proof (CUA/IAB, localhost:4173): correct URL/title, nonblank homepage, no framework overlay and no console warning/error. Normal animation readbacks changed scale from 1.00103 to 1.03993 and halo from 0.18px to 6.99px. Hover stopped the animation. Keyboard Tab focused the trigger and stopped it; Enter opened the six-family guide and open-state animation was none. Emulated reduced motion disabled the animation; cleared the emulation and confirmed it resumed. Temporary viewport override was reset.
- Mobile 390px: page width 379px, no horizontal overflow. Trigger stayed clickable without layout reflow. Desktop and mobile screenshots: `start-button-breathe.png` / `start-button-breathe-mobile.png` in the existing preview screenshot directory. This proves styling and interaction, not an increase in click-through rate.
- Existing branch/worktree/WIP retained for continued review; dependency symlink remains in use. Pre-follow-up backup: `backup-breathe-review/before.patch`. Rebuilt/restarted only the local preview and kept the homepage visible with the button breathing. No production deployment, metadata mutation, payment or customer message.
