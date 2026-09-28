-- Apply the shorter retention to existing objects as well as future uploads.
UPDATE telegram_web_support_attachments SET expires_at = MIN(expires_at, created_at + 172800000);
--> statement-breakpoint
UPDATE telegram_web_support_replies SET expires_at = created_at + 172800000;
