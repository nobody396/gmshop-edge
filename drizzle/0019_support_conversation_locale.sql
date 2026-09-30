ALTER TABLE telegram_web_support_conversations ADD COLUMN locale TEXT CHECK (locale IS NULL OR locale IN ('zh-CN', 'en-US'));
