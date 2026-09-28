# Web support attachments / 在线客服附件

## Scope

The existing web conversation and Telegram support topic remain the only message
channel. Customers can select one file or paste a screenshot, add an optional
caption (maximum 1,000 characters), preview its name, and send it. Administrators
reply with Telegram photos/documents in the same authorized topic. Administrator authorization is unchanged. Replies use the existing purpose-separated server keyring for encrypted-at-rest storage; v2 browsers retrieve plaintext only over HTTPS with the authenticated conversation cookie. Legacy RSA envelopes remain read-compatible.
The chat and header no longer promote personal WeChat contact.

No new broker, WebSocket transport, generalized media service, public bucket,
auto-resend worker, or extra queue was added. A small attachment metadata table
provides conversation ownership, send deduplication, and indexed expiry cleanup.
The existing private FILES object store holds bytes; no bot token reaches clients.

## Limits and retention

- 10 MiB per attachment; PNG/JPEG/WebP/GIF, PDF, UTF-8 TXT/LOG/CSV/JSON,
  ZIP/DOCX/XLSX. File signature/extension checks apply server-side.
- Files are retained for 2 days; expired reads are denied immediately, and the
  existing maintenance job removes up to 100 expired objects and rows per run.
- Images can be previewed; all other files force download with `nosniff`, private
  no-store caching, and same-origin resource policy. HTML/SVG/executables are not
  supported. These checks are not an antivirus guarantee.
- Reads require the same browser's authenticated support conversation, including
  when the customer opens a download link. Links are not public sharing URLs.
- Uncertain Telegram sends retain their idempotency claim; retrying the same
  selection checks the result instead of sending another copy. A permanently
  uncertain send needs operator inspection, not automatic redelivery.
- Voice/video/stickers are not included. An unsupported staff attachment produces
  a visible topic error instead of being silently discarded.

## Verification and ablation

`bun run test:support-attachments` exercises real SQLite migrations and the private
object-storage adapter with only Telegram transport mocked: upload/download,
foreign-session isolation, origin checks, closed sessions, uncertain send replay,
expiry cleanup, and encrypted/deduplicated staff replies.

Vitest checks file signatures and size boundaries, widget selection/removal/send,
ordinary text compatibility, no WeChat promotion, header behavior, D1 migrations,
and existing support-administrator authorization.

Two negative ablation experiments were run and restored:
1. Remove conversation ownership from the download query: the valid foreign-session
   access test fails.
2. Remove the server-side size cap: the oversized-file test fails.

The safeguards are necessary. A one-use metadata projection wrapper was removed;
its projection remains inline. The old WeChat dialogs and associated imports were
removed rather than hidden behind a feature flag. Tests were rerun after restoring
safeguards and deleting the unnecessary code.

## Deployment

Apply additive migration `0017_web_support_attachments.sql` before the Worker.
No existing tables or data are rewritten. Keep the previous Worker version as the
code rollback target; leave the additive table intact on rollback.

Production verification must distinguish local/mock transport tests from real
Telegram delivery. Use only a clearly marked operator-owned test conversation,
never an existing customer conversation. Do not send email or make purchases.


## Reply recovery and sending feedback

A browser whose old local RSA key no longer matches the reopened conversation
could upload messages but could not decrypt replies (OperationError). One failed
reply also blocked every later item in the polling batch. Regression coverage now
exercises a resumed session without a usable browser key, a broken legacy reply
before a good reply, and two independent reads after acknowledgment.

V2 removes new browser-specific key generation, synchronizes the conversation ID
from the server, isolates old unreadable replies with an explicit warning, and
retains mailbox rows until the common 48-hour expiry instead of deleting on the
first tab's acknowledgment. Old ciphertext for which the browser key is lost
cannot be decrypted retroactively; the sender must resend that content.

The composer immediately shows a pending bubble (including local image preview),
a spinner and elapsed seconds. It remains editable while a send is pending;
completion does not erase a newer draft. Requests have bounded timeouts, and
uncertain sends are not represented as delivered. No queue/WebSocket layer was
added. Empty polls do not rebuild the message list or load provider secrets.

Expiry applies to website records/files: the server enforces the deadline and
scheduled cleanup removes expired data. Browser history is purged while the page
is open and on the next visit. Telegram copies remain under Telegram's own
retention settings; this release does not delete the support group's history.

Ablation: removing per-reply failure isolation makes the bad-legacy-plus-new-reply
UI regression fail. The guard was restored and tests passed again. Unnecessary
new RSA key generation and first-reader deletion were removed, not wrapped.
