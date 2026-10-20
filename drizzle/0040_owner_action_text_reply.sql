-- An owner action that needs typed input (e.g. the Alipay trade number for a payout).
ALTER TABLE `owner_action_requests` ADD COLUMN `prompt_message_id` integer;
--> statement-breakpoint
ALTER TABLE `owner_action_requests` ADD COLUMN `prompt_choice` integer;
