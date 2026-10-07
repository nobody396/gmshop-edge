# Philippines Pro $200 catalog merge

The existing renewal item `624bf652-debb-48f4-ab98-6b9daab2a6ea` belongs to
ChatGPT membership product `2a794b89-3bb9-49d4-8691-0d13a1606869`.
The existing new-subscription item `0829de43-da22-420c-9866-38c83dd420f0`
is labelled 菲区新开. Renewal remains 菲区续费.

Move, never clone, the renewal item. Preserve item IDs, stock rows, channel
prices, central warehouse SKU, redemption policy and immutable order snapshots.
Hide the emptied standalone product as draft, not deleted. Its old URL redirects
to the shared product with the renewal item preselected. Guide results use the
same destination. Renewal eligibility remains current Pro / PHP 8,919.64 bill;
new subscriptions do not replace active subscriptions.

Ablation: no alias table, migration framework, shared inventory abstraction,
new product, new code generation or checkout change. One exact legacy route
redirect plus existing catalog data is sufficient. No DB schema migration.
Rollback restores the captured parent/name/status fields; it never reissues stock.
