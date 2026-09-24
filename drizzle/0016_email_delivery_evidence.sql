ALTER TABLE notification_deliveries ADD COLUMN accepted_at INTEGER;
--> statement-breakpoint
ALTER TABLE notification_deliveries ADD COLUMN provider_event_at INTEGER;
--> statement-breakpoint
CREATE INDEX notification_deliveries_provider_message_idx ON notification_deliveries(provider_message_id);
--> statement-breakpoint
CREATE TABLE email_recipient_suppressions (
  recipient_hash TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL,
  source_delivery_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
-- Legacy delivered meant provider acceptance, not a final delivery receipt.
-- Never resend these messages while collecting the missing provider evidence.
UPDATE notification_deliveries SET status = 'accepted', accepted_at = delivered_at, delivered_at = NULL WHERE status = 'delivered' AND provider_event_at IS NULL;
