# VIP buying guide — local review only

## Scope and implementation
- One fixed branch resolver and one React dialog, six retail families; no API, agent, uncertain-answer, AI or generic workflow services.
- Reuses Paraglide, existing product API/cache keys, currency formatting and Radix dialogs. No dependencies, migration, account-data upload or production writes.
- Keeps the user-provided annotated images unchanged. Examples enlarge inside a nested dialog, with fit/original-size toggle and a keyboard-scrollable image region. Closing returns to the current answer step. Only external account/billing checking links open a new tab.
- Result reads current product/variant availability and policies; no automatic cart/checkout. Exact `?item=UUID#purchase-options` link selects that option in the product page, including when unavailable; a removed requested option does not silently fall back to another option.
- Owner-confirmed Philippine Plus → Pro 5X difference-upgrade route remains unavailable until the new product exists. No guessed price or expiry date.
- Account state is not inferred from dates. Existing Pro with payment issues and unverified downgrade combinations stop without a product link. Claude requires an ended paid subscription; Max requires acknowledgement of self-managed KYC. Free accounts cannot buy Codex credits.
- Explicit verified public SKU policy mapping, not string matching or historical chat recommendations. Inactive duplicate iOS20X is excluded; the dedicated active product is used.

## Ablation
- Removed a separate copy-accessor file and kept its small localized label map in the component; no extra module layer.
- Removed redundant first-screen description and changed the six family choices to two columns on mobile to reduce scrolling.
- Mutated pending-upgrade stop to regular 5X: regression tests failed, then restored.
- Removed stock gate: regression tests failed, then restored.
- Removed overwrite-consent gate: regression tests failed, then restored.
- Retained the locale resolver, qualification checks and exact-SKU selection because removing them changes correctness.

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
- No live deployment or customer messages. New difference-upgrade product remains pending; unverified combinations remain blocked.
