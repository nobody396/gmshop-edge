import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { shopOrderItems } from "./commerce";

export const gptUpgradeOrders = sqliteTable(
	"gpt_upgrade_orders",
	{
		orderItemId: text("order_item_id")
			.primaryKey()
			.references(() => shopOrderItems.id),
		quoteId: text("quote_id").notNull(),
		activeKey: text("active_key").unique(),
		quoteTokenEncrypted: text("quote_token_encrypted").notNull(),
		priceMinor: text("price_minor").notNull(),
		state: text("state", {
			enum: ["pending", "delivered", "needs_review", "cancelled"],
		})
			.notNull()
			.default("pending"),
		statusUrl: text("status_url"),
		errorCode: text("error_code"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at").notNull().default(0),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		index("gpt_upgrade_orders_retry_idx").on(table.state, table.nextAttemptAt),
	],
);
