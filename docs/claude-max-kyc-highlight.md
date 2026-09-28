# Claude Max KYC notice presentation / KYC 提示展示

The Claude product description remains the source of the owner-approved wording.
When it begins with `重要提示｜Claude Max 身份验证（KYC）` and a blank-line
separator, render that first block as an amber warning card. Keep the remaining
product description outside the card. The notice explicitly targets Max 5X and
Max 20X; do not change Pro eligibility, prices, stock, checkout, or fulfillment.

文案仍来自商品描述；只将已有 KYC 提示分离为高对比警示卡，重点词高亮。
不新增弹窗、勾选门槛或配置层，不改写已确认文案。

Descriptions without the exact prefix (including English) retain their existing
rendering. Stored text is escaped by React, not rendered as raw HTML.

Validation: component tests cover verbatim text, emphasis, ordinary/English
fallback, malformed-prefix fallback, and HTML escaping. Check desktop/mobile,
light/dark appearance, and Max plan selection on the customer-visible page.
