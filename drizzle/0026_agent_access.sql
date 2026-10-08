CREATE TABLE agent_access_orders (
 order_item_id TEXT PRIMARY KEY NOT NULL REFERENCES shop_order_items(id),
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('subsite','api')),
 email TEXT NOT NULL,
 active_key TEXT UNIQUE,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','revoked','cancelled')),
 remote_user_id INTEGER,
 domain TEXT,
 attempt_count INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 error_code TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX agent_access_orders_retry_idx ON agent_access_orders(state,next_attempt_at);
