# Optional Turnstile protection

The runtime accepts `TURNSTILE_SITE_KEY` (public) and `TURNSTILE_SECRET_KEY`
(secret). Both absent means **not protected**. Partially configured means the
protected endpoints fail closed with HTTP 503. No secret is exposed through the
public `/api/auth/turnstile-config` endpoint (no-store).

Protected POST endpoints: `/api/auth/sign-up/email`, `/api/auth/sign-in/email`,
and `/api/support/web/conversations`. OAuth/Telegram callbacks, email OTP,
payment callbacks, existing support messaging and supply APIs are unchanged;
they retain their existing authentication and durable rate limits.

The browser sends a fresh `cf-turnstile-response` header for each attempt. The
server verifies with Cloudflare and checks success, exact hostname and action.
Missing, expired, replayed or wrong-context tokens are rejected; verifier outages
fail closed. Client controls disable submission until the challenge is ready.

## Activation (operator coordination required)

1. Create a managed widget restricted to the actual storefront hostname(s).
2. Store the secret only in Agent Switch on this machine; pipe creation output
   directly into `agent-switch secret set --stdin NAME`, never print it.
3. Inject the Worker secret from an inherited non-TTY FD into Wrangler's stdin;
   never put it in a project environment file, arguments, D1 or deployment logs.
   Set the public site key in Worker runtime configuration. Bun receives both
   values through its launch environment, not a repository file.
4. Deploy code and both bindings together. Verify the config endpoint, visible
   register/password-login/support widgets, real token success and rejection
   without a token. Verify Google/Telegram login and payment callbacks separately.
5. An emergency rollback must remove **both** bindings and explicitly record
   that protection is disabled; deleting one binding deliberately fails closed.

Code/unit tests alone do not prove production activation. No widget or credentials
were created by this change. Live browser challenge completion and deployment
remain operator verification steps.

## Minimality and regression proof

One small client hook/component and one server verifier; no SDK, new dependency,
database table, settings framework or generalized middleware. Existing runtime
adapters, error mapping and query cache are reused. Removing hostname/action
checks makes the regression suite fail; restoring them passes. Focused tests also
cover optional configuration, partial configuration, token size, upstream
outages, exact endpoint scope, browser expiry and token reset after attempts.
