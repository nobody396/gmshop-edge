# Remove retired PH Pro opening-eligibility copy

Owner says account opening eligibility no longer needs checking. Remove the exact PH new-activation variant's warning link, qualification panel and image entry, and unused component/translations. Preserve renewal SKU rules, subscription-expiry requirement, prices, stock, upstream routes and historical orders. Keep the existing static source image for other work-in-progress references.

Base is deployed 805e82e, not the unshipped buying-guide branch. No migrations or backend logic change. Production SKU policy changed independently with audit and before/after readback. Regression tests require no retired eligibility UI or locale keys. No payment/recharge/email test.
