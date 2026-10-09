# Payment creation failure evidence

A failed QR checkout is not an image-download failure: the order page renders
an SVG from the stored checkout URL. The EPay adapter previously collapsed
provider refusal and malformed responses, and the payment service then stored
only `provider_create_failed`. The first checkout handler returns the failed
attempt to let the customer retry, so the original exception was lost.

The adapter now separates HTTP, network, timeout, JSON/schema, provider refusal,
and missing/invalid checkout URL failures. The service atomically stores the
failure code plus an existing `audit_logs` record (`payment.creation_failed`,
target `payment_attempt`). The audit contains elapsed time, IP family (not IP),
HTTP status and bounded/redacted provider code/message when present. No new
schema, queue, automatic retries, checkout fallback or payment-state workflow
is introduced. EPay errors rethrown by the service carry only a generic public
message and local error code, never the diagnostic object.

Do not store credentials, signatures, whole responses, payer IP/email or checkout
URLs. Generic exceptions are not serialized. Idempotent replay reuses the failed
attempt and must not call the provider or duplicate the audit. A late payment
callback must not be overwritten by the failure update.

Operations: query the audit by payment-attempt ID with admin audit permission.
A refused order is not the same as a transport-ambiguous order. Before any manual
recovery, query the original merchant order at the provider; do not assume a
failed response means no upstream order exists or automatically switch payment
attempts. Never disable risk controls to make a checkout pass.

The 2026-10-09 incident has seven failed attempts on four CNY 125 orders for one
contact. Read-only provider lookups report all seven absent; a successful-order
control lookup matched its amount. The historical refusal text is not recoverable
from the old local failure records. The authenticated provider UI also has no matching orders; its operation log
contains account operations, not refusal responses, and the current blacklist is empty. These changes fix the confirmed evidence-loss bug;
they do not establish or claim to fix the customer's historical provider refusal.

Verification: a Miniflare D1 integration test drives the real createShopPayment
path with the documented EPay failure envelope, checks preserved/redacted audit,
failed/no-URL state and idempotent replay. Adapter tests cover response and
transport variants, bounded redaction and no automatic retry; no real payments.
