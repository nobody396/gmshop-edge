# Authentication incident hardening / 认证事件加固

## Scope / 范围

Based on production commit `0d47805`; preserve supply-console fixes, do not deploy the stale canonical checkout. This change does not alter payment callbacks, delivery, supplier order APIs, or credentials. No schema migration is needed.

本次基于生产版本，不回退现有供货台修复；不改变支付、交付及代理下单协议。

## Controls / 控制

- Application-layer `security.blocked_ips` shares the existing request settings read, blocking confirmed sources on alternate allowed domains and the workers.dev entry too (liveness probe remains available).
- D1 atomic counters before authentication: 20 auth writes/minute/IP, 5 logins/minute/IP, 5 registrations/hour/IP, 3 verification requests/minute/IP, 10 attempts/minute/normalized email across rotating IPs. CF-Connecting-IP only; missing IPs share a conservative bucket. These fixed windows bound abuse, not eliminate it; an attacker can temporarily exhaust an identity's minute budget.
- Separate durable audit evidence for exhausted windows. No password, token or raw email is stored in these events.
- Require verified local email before automatic social linking; verification policy cannot silently disable itself when email transport is unavailable.
- Require verified email before issuing a new purchasing API key. Existing keys and normal commerce paths are unchanged.
- Optional owner Feishu digest using existing configured operational recipient: last completed 15-minute window, >=10 authentication failures or any durable rate-limit event; no message for quiet windows; one attempt/window with sent/failed audit. Provider acceptance is not human read confirmation. No automatic retries after uncertain send, no credentials in logs.
- Enable live `auth.require_email_verification` only after checking root is verified and mail channel is healthy. Do not force-log-out ordinary customers.

## Verification / 验证

Integration tests use isolated Miniflare D1, including concurrent callers, IP rotation, spoofed forwarding headers, window reset, audit redaction, alert deduplication/failure and commerce exclusions. Full standard checks are required before release. Live tests must not register accounts or send unsolicited verification mail.

## Rollback / 回滚

Previous production Worker version: `8ced3e9c-eefc-4246-bab0-00fdb098c095`. Roll back Worker code if auth/commerce regresses; retain incident IP block and account quarantine. Restore only settings changed by this incident, with audit. Do not remove evidence or blanket-enable quarantined accounts.

## Remaining setup / 后续配置

Turnstile requires a securely provisioned runtime verifier secret and end-to-end form/server validation, not a frontend-only checkbox. Administrator MFA/Passkey needs owner enrollment and recovery verification before enforcement. Neither is claimed implemented by this patch. Cloudflare token lacks WAF/Access API permissions; existing WAF changes are verified through dashboard.

上线配置：强制邮箱验证；现有 WAF 精确封禁 3 个来源；新增认证 POST 接口 10 请求/10 秒/IP 的短时阻止。未启用全站质询，不拦截正常支付回调。
