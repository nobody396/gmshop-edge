-- Only daily score counts; no raw IP, browser fingerprint or account identity.
CREATE TABLE IF NOT EXISTS ip_check_score_buckets (
 day INTEGER NOT NULL,
 score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
 count INTEGER NOT NULL DEFAULT 0 CHECK(count >= 0),
 PRIMARY KEY (day,score)
);
