# Email reputation and delivery evidence / 邮件信誉与投递证据

## Scope / 范围

Based on production `ca2d935`. Keep email verification, commerce delivery, payment callbacks and existing authentication protections. No production migration, deploy, suppression-list mutation or email send is authorized by local validation.

基于生产 `ca2d935`，保留邮箱验证、支付与交付路径。此次本地验证不部署、不更改生产数据、不发送测试邮件。

## Controls / 控制

- Block the IANA reserved example namespaces and `.invalid`, `.test`, `.example`, `.localhost` before registration/email changes and before queueing/sending mail. Matching uses complete DNS labels. Do not assume missing MX means undeliverable; this patch adds no synchronous DNS dependency and no mailbox probing.
- Retain per-IP durable limits; add a normalized, hashed mailbox budget of three outbound verification/OTP/reset/signup requests per ten-minute fixed window across rotating IPs. Code consumption, session reads and payment paths are excluded.
- Recheck disabled accounts for `auth.*` messages at enqueue and dequeue. Other legitimate transactional messages are not blanket-disabled by account quarantine.
- Keep provider acceptance distinct from final delivery: `pending → sending → accepted → delivered | bounced | rejected`; `suppressed` means no provider send. Only retry dispatch failures; accepted and terminal messages cannot be automatically resent by Queue replay.
- Application-owned hard-bounce suppressions store recipient SHA256, cause and source reference, not plaintext mailboxes. Permanently suppress only explicit nonexistent-mailbox/domain or Null MX evidence. Transport or temporary mailbox-full failures do not create permanent suppression. Suppressions survive notification-log retention.
- Existing `delivered` rows meant submission success. Migration `0016` reclassifies them as `accepted`, preserves their original acceptance time and clears the falsely named delivery time. It does not queue or resend mail. Final state is recovered from provider evidence, not guessed from age.

明确无效地址在注册和发送前拦截；不采用“无 MX 一律封禁”，不探测真实邮箱。队列消费前再次检查禁用账号和已有硬退信记录。服务商接受与收件服务器接受分开，历史假送达降为“待确认”，不重发。正常账号通知、交付和支付回调仍遵循原有业务授权。

## Provider reconciliation / 服务商回填

`bun scripts/reconcile-email-delivery.ts --account ACCOUNT_ID --database DATABASE_ID --zone ZONE_ID --since 2026-09-17T08:00:00Z --until 2026-09-24T08:00:00Z`

- Dry-run by default. Add `--execute` only after explicit production data-update authorization and deployment/migration verification. Window must be UTC and at most seven days. For first recovery, use the desired recent provider-event window even when the original send was older.
- Account/zone and configured Cloudflare sender domain must match. Reads `CLOUDFLARE_API_TOKEN` only from Agent Switch FD 3. Required permissions are D1 read (edit for execute), zone read and zone analytics read. Never copy credentials into project files or Worker bindings for this job.
- Splits saturated 500-event queries recursively; stops rather than silently truncating an irreducibly saturated window.
- Matches exact Message-ID, sender, decrypted recipient and acceptance time; requires final provider events. Unknown events, unmatched rows and pending retries do not become failures. Conflicting or duplicate mappings stop reconciliation.
- Apply is idempotent and compare-and-set guarded; rereads each result. Hard-bounce suppression is written before status (safe if interrupted); a rerun completes the status write. Never resets attempts or queues a resend. If only some rows were applied, inspect printed applied IDs and rerun the same window; do not resend email.
- The command does not print mail bodies, tokens, plaintext recipients or secrets. Output IDs, status and provider event times are audit evidence only.
- This patch provides an owner-local on-demand reconciliation command, **not** an installed scheduler or a webhook integration. Until the command is run, the UI honestly says provider accepted / delivery unconfirmed. Recurring scheduling needs separate authorization.

回填默认只预览；授权后才使用 `--execute`。只读服务商事件，精确匹配消息、收发件人与时间，不重发任何邮件。无最终证据就保持待确认，冲突立即停止。当前提供人工按需回填入口，没有新增自动任务；不得把“代码已完成”说成线上已经同步或信誉恢复。

## Verification and rollout / 验证与上线

- Isolated D1: reserved recipient never reaches outbox/provider; disabled queued auth mail is suppressed; delivered/failed evidence is exact, monotonic and replay-safe; hard-bounce suppression blocks new mail; reconciliation query uses its message-ID index.
- Auth: reserved signup fails before identity creation, legitimate signup/reset/change-email still works, rotating-IP verification requests share the mailbox limit. Existing Turnstile tests cover missing/expired/incorrect tokens and payment/OAuth exclusions.
- CLI: mock API and Agent Switch boundary; dry-run has no writes, execute performs only evidence/suppression writes plus readback, never email sends.
- Before rollout take a D1 backup, compare current production head with this base, test `0016` on a database copy, then deploy the matching code and migration together. Old code does not understand `accepted`; do not roll back only code while retaining this migration.
- To undo an accidental application-owned suppression, independently verify mailbox correction and explicitly authorize removing the exact hash. Never clear all provider suppressions or retry the entire failed batch.
- Real inbox tests require separate authorization for the owner's exact mailbox. Provider delivery confirms recipient-server acceptance, not inbox placement or reading. Seven-day reputation history is not reset by this patch.

## Local review / 本地复核

Ablation removed an unused recipient-hash column on notification rows; only the suppression table needs that digest. No new generic mail framework, synchronous DNS probe, provider, scheduler or production credential was introduced.

Browser validation used an isolated local D1 and mock terminal email records, not production users or recipients. The local installer and admin email-records route were exercised; Chinese dark desktop and English light desktop/mobile show accepted, delivered, bounced and suppressed separately. Mobile retains the existing horizontally scrollable table. Refresh and keyboard focus were exercised. A dev-only HMR sidebar error during parallel builds cleared on full reload; final route checks had no new errors.

Production read-only check: Turnstile public/secret bindings are present; no live registration probe was sent. No pending/sending/failed `auth.*` notification backlog was found. These observations do not prove real inbox delivery or deployment of this patch.

Final verification (2026-09-24 16:44 Beijing): typecheck passed; Vitest 1,236 passed with 2 existing TODOs; Bun runtime 23 passed; Biome checked 910 files without fixes/warnings; both Workers and Bun builds passed. Final source changes were frozen for this complete run. The empty local D1 migration, historical-state conversion, query-plan checks and browser scenarios above passed. Build chunk-size notices and jsdom's unsupported `scrollTo` notice are non-failing tooling warnings. No production migration/deployment/reconciliation or real email test was performed.
