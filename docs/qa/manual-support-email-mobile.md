# Manual support email + mobile header

## Scope
- Keep one responsive storefront header: Invoice + Support on mobile; existing desktop navigation unchanged.
- Remove residual WeChat wording. Support has web chat / Telegram group / private Telegram options.
- Exact customer notice: 客服回复了会通过邮件提醒你返回网页继续沟通。
- Email is opt-in by the support administrator's explicit Telegram button click, never by reply/time/polling. `/notify` only shows the button for existing topics.
- Reuse the current encrypted notification/outbox pipeline, recipient suppression and delivery status handling. No migration, extra queue, scheduler, generic notification framework or magic-link login.
- Pin `cloudflare_email` and `老实人AI VIP <no-reply@laoshirenvip.com>` at enqueue and send. Check support-group administrator, matching topic/conversation and an unexpired reply. Deduplicate by conversation + latest reply sequence.
- Reminder contains no transcript, file or session credentials. Website link opens `#support`; recipient must use the original conversation browser. Website retention remains 48 hours.

## Evidence
- Native SQLite integration suite covers normal replies producing zero email, administrator/topic checks, unexpired reply requirement, sender/provider/disabled-channel rejection, suppression, encrypted generic contents, deduplication, audit and mock binding acceptance exactly once.
- Ablation: removing administrator check or sender check caused corresponding integration tests to fail; restored and passed.
- Ablation: restoring mobile header hiding caused regression guard to fail; restored and passed.
- Responsive QA: 320 px initially exposed invoice wrapping; constrained brand width and prevented nav wrapping. Rechecked 320/390, no horizontal overflow. Invoice navigation reached the actual invoice form. Support menu showed all three actions. `#support` opened chat and exact notice. No browser console errors in local flow.
- Live Cloudflare preflight: paid Workers plan current; VIP sending domain enabled/DNS configured; production EMAIL binding exists; D1 channel exact approved sender/provider and enabled.
- No live test email sent. Provider acceptance test uses a fake binding only. Real delivery/inbox receipt requires owner's manual trigger and independent readback.

## Final regression
- Typecheck, Biome, Workers build and Bun build passed.
- Vitest full run: 239 files / 1253 tests passed, one source-import scanner exceeded the default 5 s under concurrent build load (not an assertion failure); isolated rerun passed all 10 tests in 2.79 s. Two pre-existing todo tests remain.
- Final native suites run separately because Vitest's timeout stopped the chained command.
- Real bot-update integration additionally verified ordinary admin text reaches the reply store without creating email, `/notify` shows a button only, and the callback creates the notification.
