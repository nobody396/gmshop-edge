# Supply console JSON compatibility

The supply map accepts normal JSON objects and legacy JSON-encoded strings. The console now displays loading and query-failure feedback instead of a silent empty table. No catalog, price, stock, or fulfillment setting changes.

## PH on-delivery conversion inventory

Available raw PH stock counts as deliverable only when the configured owned-delivery SKU matches the central mapping. Reserved rows are excluded; ordinary central-backed customer codes retain the central pool cap. Raw stock is counted once, not added twice when central keys also exist. This reports inventory capacity, not supplier redemption validation.
