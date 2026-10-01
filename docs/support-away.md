# Support away replies

This feature only covers the Web/Telegram customer conversations associated with
the configured support-center forum. It does not manage personal account chats,
the public discussion group or channel posts. It reuses the existing webhook,
forum topics and encrypted Web replies: no new bot, polling, scheduler or LLM.

## Operator commands — disabled by default

An authorized human administrator sends these commands inside the support center:

- `/away status`: read status and the guide URL.
- `/away guide <HTTPS URL>`: register the published buying guide and disable away
  replies. Only `laoshirenvip.com`, `cn.laoshirenvip.com` and `shop.laoshirenai.com`
  are allowed. Credentials, non-standard ports and HTTP are rejected.
- `/away on`: enable one round; a guide URL is required.
- `/away off`: stop new away replies without disabling regular customer support.

Repeated `on` is idempotent. Only off-then-on creates a new round. Updating the
guide requires another explicit activation. Private chats, other groups, forwarded
commands and bots cannot operate this switch. The operator must verify the guide
has been published: the code validates URL syntax/domain, not remote availability.

## Customer behavior

New, successfully forwarded customer text or attachments receive at most one
acknowledgement per conversation per activation. No history scan or backfill.
Delayed Telegram messages predating activation are ignored for away replies
(Telegram timestamps have second-level precision). Concurrent/duplicate messages
and uncertain deliveries do not cause repeated acknowledgements. Turning off does
not retract messages or cancel already in-flight network requests.

The approved Chinese text invites the customer to leave their question, links to
the guide, and promises a later human response. Only Web conversations (which
require an email at creation) include the owner's manual-email reminder sentence.
Telegram conversations omit that email promise. Both zh-CN and en-US follow the
customer's selected language, not staff language. The acknowledgement is mirrored
into the relevant staff topic; Web customers receive it in their own conversation,
encrypted at rest. A failed away reply does not fail normal customer delivery.

## Email stays manual

Away replies never enqueue email, schedule delayed notifications or press the
existing email action. The Web reply's `is_away_reply` provenance prevents the
manual reminder from treating an automated acknowledgement as a human reply.
The existing recent-human-reply, sender/provider, authorization and idempotency
checks remain in force. Provider acceptance is not inbox delivery proof.

## Minimal implementation

One object in `system_settings` (`telegram.support.away_mode`) holds the switch,
activation round/time, guide and support chat. Atomic once-per-round reservations
reuse the `telegram_support_away` namespace in `replay_receipts`; active-round
receipts survive ordinary 90-day cleanup. Existing `audit_logs` record switch
changes and the administrator. Migration `0021_support_away_reply_source.sql` only
adds Web reply provenance, without regenerating the installation baseline.

Run `bun run test:support-away`. The integration suite uses temporary SQLite,
actual customer/Telegram public interfaces and mocked Telegram SDK network
boundaries. It does not send real customer messages or emails.

Local implementation is not deployment or activation. Wait for the published
guide URL before releasing and activating the feature.

Storefront HTTPS guide links are clickable and open in a new tab without losing the support conversation. External URLs and untrusted HTML remain escaped plain text.
