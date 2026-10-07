-- 0023/0024 are reserved by concurrently developed agent access / promotion work.
CREATE TABLE redeem_exception_todos (
  code_id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,
  state TEXT NOT NULL CONSTRAINT redeem_exception_todos_state_check CHECK (state IN ('open','resolved')),
  severity INTEGER NOT NULL CONSTRAINT redeem_exception_todos_severity_check CHECK (severity IN (1,2)),
  fingerprint TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  revision INTEGER NOT NULL CONSTRAINT redeem_exception_todos_revision_check CHECK (revision > 0),
  alert_attempted INTEGER NOT NULL DEFAULT 0 CONSTRAINT redeem_exception_todos_alert_attempted_check CHECK (alert_attempted IN (0,1)),
  observed_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL,
  resolved_at INTEGER
);
--> statement-breakpoint
CREATE INDEX redeem_exception_todos_open_idx ON redeem_exception_todos (state, last_checked_at, code_id);
