CREATE TABLE telegram_web_support_attachments (
 id TEXT PRIMARY KEY NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES telegram_web_support_conversations(id),
 source_key TEXT NOT NULL,
 name TEXT NOT NULL,
 mime TEXT NOT NULL,
 size INTEGER NOT NULL,
 status TEXT NOT NULL CONSTRAINT telegram_web_support_attachments_status_check CHECK(status IN ('pending','sent')),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX telegram_web_support_attachments_source_uidx ON telegram_web_support_attachments(conversation_id,source_key);
--> statement-breakpoint
CREATE INDEX telegram_web_support_attachments_expiry_idx ON telegram_web_support_attachments(expires_at, id);
