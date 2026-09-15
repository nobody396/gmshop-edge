# Owned IP check / 自有 IP 检查

## Scope and reference

- Base: `b92b0f6` (existing 1.16.2 delivery worktree), branch `feat/owned-ip-check`.
- Reference UX: https://ip-check.leeguoo.com/ and
  https://blog.leeguoo.com/en/posts/claude-account-ban-network-detection/
- Complexity: L2, independently rebuilt diagnostic page, not a pixel-identical clone.
  Retains result/evidence/browser/self-check hierarchy; uses existing store header,
  typography, spacing, buttons, light/dark themes and localization.
- No original code, text paragraphs, images or proprietary APIs copied. No reusable
  source license was established, so the article and implementation were not mirrored.
- Primary references: https://developers.cloudflare.com/workers/runtime-apis/request/
  and https://www.anthropic.com/supported-countries (Claude.ai section, 2026-09-15).
  Region list is a dated snapshot, not live policy. Ukraine is manual-review because
  country-level geolocation cannot establish compliance with territorial exceptions.

## Implementation

- `/ip-check`: thin public route; page lives alongside feature logic.
- `/api/ip-check`: GET current connection only, before i18n request cloning and after
  the existing Host authority guard. No query-IP, credentials, database writes,
  third-party risk lookups, queues, order mutations, payment or notification actions.
- Uses Cloudflare's original `request.cf` and `CF-Connecting-IP`; never trusts Bun
  forwarding headers. Localhost ignores Wrangler's synthetic metadata. Private and
  CDN no-store headers prevent one visitor's result being cached for another.
- Hosting: explicit small ASN set and organization regex, heuristics only. Unknown
  VPN/proxy/Tor/abuse flags are never converted to false. No residential assertion.
- Client: 10-second timeout, cancellation on unmount, retry, no stale result on error,
  response validation, default IP masking. Browser timezone is read locally.
- WebRTC: optional Google STUN connection, disclosed before opt-in, 5-second bound,
  `srflx` candidates only, deduplication and cleanup. Candidates are masked, not
  uploaded or scored. No candidates is inconclusive, not a no-leak certificate.
- Source file `check.ts` is isomorphic and side-effect-free; shared result schema and
  mask function are reused. No additional dependency or service/repository layer.
- Product and checkout use the existing shared purchase-guide component; its link is
  now relative `/ip-check`. Existing account/billing checks remain unchanged.

## Ablation / 消融

Removed from the reference concept: score/ranking, share-image rendering, API keys,
arbitrary IP lookups, persistent history, blog duplication and secret-printing shell
commands. None is needed to let customers inspect their current connection.

Tests ablate ASN, organization, region, edge metadata, third-party availability and
WebRTC availability separately. Missing evidence must degrade to incomplete/unknown,
not improve a verdict. Region restrictions take priority over hosting. Timezone and
WebRTC are not inputs to the assessment, so removing them cannot change it.

## Verification

- Focused Vitest: 35 checks pass (rules, ablations, privacy, locales, loading/error/
  retry, default masking and WebRTC lifecycle).
- Browser: actual local route rendered; refresh returns incomplete in local mode;
  Chinese/English and light/dark viewed; 390 px phone view has no document horizontal
  overflow; guide and opt-in controls wrap; keyboard Tab reaches official-policy
  link with visible outline; no warning/error console entries at check time.
- Empty local D1 migration passed (existing migrations 0000–0013); no schema change.
- Local API test: GET returns no-store incomplete, POST/query-IP are rejected.
- Full gates: see `artifacts/ip-check/` logs; record final outcomes below.
- Not verified: real deployed Cloudflare visitor metadata, classification accuracy
  against a labeled network dataset, live STUN reachability, production checkout
  readback. No deployment, push, payment, email or notification was performed.

### Reference comparison (qualitative, not pixel similarity)

- Structure: complete for retained sections; omits scores/ranking/share by design.
- Visual: intentionally store-native, not a one-to-one yellow sketch theme clone.
- Interaction: refresh, masking and optional probe covered by tests; actual local
  refresh and keyboard navigation verified in browser.
- Responsive/localization: desktop and 390 px inspected; both locales rendered.
- Branding/content: independent store copy; no original brand links in customer page.
- Function: real edge endpoint implemented; production end-to-end remains unverified.

## Run locally

From this worktree: `bun run db:migrate:local`, then
`bunx vite dev --host 127.0.0.1 --port 3016`. Open `/ip-check`.
Local mode intentionally does not show a real egress verdict; use unit fixtures to
exercise complete result branches, not hardcoded data in the production page.

### Final gates

- `bun run typecheck`: passed.
- `bun run test`: 1,064 Vitest tests passed (215 files; 1 existing skipped file,
  2 existing TODO tests), plus 23 Bun runtime tests passed. No failures.
- `bun run check`: 870 files passed, no fixes applied.
- `bun run build`: Workers production build passed (local build only).
- `bun run build:bun`: Bun production build passed.
- Focused security suite: 10 tests passed; actual local endpoint returned HTTP 200
  with private/CDN no-store, query lookup HTTP 400 and POST HTTP 405.
- All changes remain uncommitted in the named feature worktree. Main and existing
  deployment worktrees were not edited; no deployment or live catalog mutation.
