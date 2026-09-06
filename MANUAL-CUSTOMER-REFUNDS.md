# Manual customer refunds

Use this flow when the original payment provider cannot refund automatically,
including EPay and GMPay.

## States that must remain distinct

| Evidence | Order/refund state | Meaning |
| --- | --- | --- |
| Refund decision recorded | `refunding` / `processing` | Money has not necessarily left the merchant |
| Transfer sent but waiting for the customer | `refunding` / `processing` | Not refunded; the transfer may expire or return |
| Customer accepted the transfer, or the provider says succeeded | `refunded` / `succeeded` | Refund is complete |

Never treat a sent transfer, provider acceptance, screenshot, or queued job as
proof that the customer received the money.

## Operator workflow

1. Resolve the exact order and confirm the paid amount, payment provider,
   existing refunds, delivery state, and whether the delivered asset can still
   be used.
2. Decide asset disposition separately. Disable, replace, recover, or accept the
   cost of the delivered asset. A customer refund does not prove that a supplier
   refunded the upstream order.
3. In **Orders**, choose **Refund**, enter the normal currency amount (for
   example `125`, not `12500`), and record a customer-safe reason. This reserves
   the refundable balance and moves the order to `refunding`.
4. Return the money outside GMShop Edge through the original payment channel.
   Keep the provider or transfer reference.
5. While a transfer says waiting for acceptance or a provider says processing,
   leave the order in `refunding`.
6. Only after the customer accepted the transfer, or the provider explicitly
   reports success, open the order workspace, choose **Confirm external
   refund**, enter the reference, and affirm that the funds were returned.
7. Read back the order and refund. Require `shop_orders.status = refunded`,
   `refunds.status = succeeded`, a completion timestamp, and the expected
   customer notification outcome.

## ZPAY original-route refunds

The EPay adapter enables automatic refunds only when the encrypted service
origin is exactly `https://zpayz.cn`. Other EPay-compatible services remain
manual.

Before sending a ZPAY refund, the adapter queries the original payment and
requires the provider order number, merchant order number, payment method,
paid status, and full amount to match. Partial ZPAY refunds are rejected by
this preflight. A successful synchronous ZPAY response completes the refund.

ZPAY does not document a refund-status query or a retry idempotency contract.
If the refund request times out, returns malformed data, or otherwise has an
ambiguous result, GMShop Edge stops automatic retries and leaves the refund in
manual reconciliation. Check the ZPAY merchant order before completing or
retrying anything; never risk a second refund.

The ZPAY account balance pays platform fees. It is not the source of the
customer refund. ZPAY's merchant order page warns that the linked Alipay
balance must be sufficient for an Alipay refund. If it is insufficient, fund
the linked Alipay merchant balance rather than recharging the ZPAY fee balance.

Never start a ZPAY original-route refund after a separate WeChat, Alipay, bank,
or cash transfer has been sent. Finish or cancel one path before using another.

## Accounting and supplier truth

- Customer refund amount, channel fee, supplier cost, and supplier recovery are
  separate facts.
- A completed customer refund reverses the customer entitlement, but a supplier
  order that was already `supplied` remains `supplied` unless an independent
  supplier-refund workflow proves recovery.
- Pending supplier orders may be stopped when the customer refund completes so
  they cannot purchase inventory after the sale has been reversed.
- Do not delete payment, delivery, refund, supplier, or audit records.
