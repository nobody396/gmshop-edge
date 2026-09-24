# Owner sale alert deduplication

Concurrent queue drains and cron sweeps could read the same pending event and send before either marked it published.

The sender now atomically leases the existing `next_attempt_at` field for two minutes before external I/O. Only the claimant sends. All completion, defer and retry writes are fenced by that lease. The lease uses wall-clock time rather than the potentially old scheduler timestamp. A crashed worker leaves a reclaimable lease, not a permanently stuck event. No schema migration or new queue is needed.

The existing event ID is also passed as Feishu `uuid`, covering ambiguous transport responses within Feishu's one-hour deduplication window. This is not an unlimited exactly-once guarantee across long outages. Other Feishu callers omit the optional key and retain their behavior.

Regression coverage: three concurrent publishers, active and expired leases, failed-send retry, and UUID request serialization. Integration tests apply all migrations to empty D1. Do not replay customer orders or send live test messages as verification.

Scope: internal owner notifications only; no customer email, payment, inventory or fulfillment changes. Simplification review: reuse existing scheduling field and transport; no new table, migration, dependency or generic lock abstraction.
