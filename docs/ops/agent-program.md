# Agent management (GMShop → agent-shop)

`/admin/agents` is available to enabled `root` / `admin` users with the
`operations:read` permission. Mutations also require `operations:update`.
The page displays agent accounting, fee-based rebates, owner-reviewed leaderboard
rewards and pending withdrawals from the same agent-shop rules API as the agent
center. Store profit is not available upstream and is deliberately not inferred
from agent profit.

## Server-only binding

The optional Worker secret **`AGENT_SHOP_PROGRAM_TOKEN`** authenticates calls to
`https://lsrai.shop/api/internal/reseller-program/`. It must match agent-shop's
`reseller.program.internal_api_token`. An absent secret fails closed; the token
is never returned to the browser. For Bun, the same named runtime binding is
supported. No secret value belongs in Wrangler vars, project `.env` files,
documentation, logs or source control. Provision it via the approved Agent Switch
secret workflow and the deployment's secret injection process; this PR does not
provision secrets or deploy anything.

All mutation operators are derived server-side as `gmshop:<authenticated user id>`;
opening-fee edits require a reason. The upstream audit retains old/new fee values
and the operator. Recording a withdrawal as paid requires the Alipay transaction
ID and does **not** send a transfer. Verify actual payment first.

Subsite purchase fulfillment supplies the actual order `paid_minor` amount as an
exact decimal `paidAmount`, so future rebates are capped at what was paid rather
than the current catalog price. API-only purchases do not set an opening fee.

## Verification and rollback

Run focused agent-program security/UI tests, the agent-access integration tests,
`bun run typecheck` and `bun run build`. No live payment/email/Telegram smoke test
is authorized. Revert this PR to remove the page and API calls; no GMShop database
migration is introduced. The unused Worker secret may safely remain configured.
