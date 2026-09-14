# Independent invoice entry

VIP invoice requests stay on `/invoice`. Navigation and order links do not leave the storefront. The page calls the existing central public invoice API using its supported CORS policy, explicitly omitting credentials. VIP offline applications retain their source, and payment returns use laoshirenvip.com. lsrai.shop keeps its own page. No extra proxy, database, authentication system or notification pipeline is added.

## Submission error handling

Check HTTP and business status before parsing invoice success fields. Error responses may be HTTP 200 with a nonzero status_code and a data object containing only request_id. Display the service error, not a Zod report. Invalid successful responses use the localized generic error. A failed create can already have a pending invoice record: GMShop retries must resume that record using identical invoice details and the original payment amount/reference, without overwriting a paid callback.
