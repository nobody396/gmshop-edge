# Independent invoice entry

VIP invoice requests stay on `/invoice`. Navigation and order links do not leave the storefront. The page calls the existing central public invoice API using its supported CORS policy, explicitly omitting credentials. VIP offline applications retain their source, and payment returns use laoshirenvip.com. lsrai.shop keeps its own page. No extra proxy, database, authentication system or notification pipeline is added.

## Submission error handling

Check HTTP and business status before parsing invoice success fields. Error responses may be HTTP 200 with a nonzero status_code and a data object containing only request_id. Display the service error, not a Zod report. Invalid successful responses use the localized generic error. A failed create can already have a pending invoice record: GMShop retries must resume that record using identical invoice details and the original payment amount/reference, without overwriting a paid callback.

## All-inclusive invoice pricing and display

The order amount is the already-paid base, not the final face. The backend solves face = base + additional payment, where additional payment = round(face × the saved application rate, 2) + optional screenshot fee (CNY 5) + round((service fee + screenshot fee) × channel rate, 2). Wallet has no new channel fee. The frontend never calculates money independently. At a CNY 670 base and 4% channel rate, the face/payment are 714.58/44.58 without a screenshot and 720.14/50.14 with one.

Preview and payment status prominently show the final printed invoice amount separately from the additional payment. New previews must advertise `fees_included: true`. Prefill uses `invoice_base_amount`, never the final face. Historical statuses keep their saved amounts; paid requests are not repriced. Release the central backend and its additive base-column migration before this frontend. Local implementation does not deploy, pay, issue invoices, or send notifications.

New VIP retail and agent-shop applications use a 6% invoice tax fee; Luoche settlement remains independently at 3%. The backend resolves the source and returns `rate_percent`; new quotes without it fail closed. Existing applications, including unpaid requests, retain their saved rate. Historical statuses may still display 3%. No new configuration table, migration, or paid-order repricing is introduced.
