import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { shopOrders } from "./commerce";
export const rewardEntries = sqliteTable(
	"reward_entries",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		deltaMinor: text("delta_minor").notNull(),
		balanceAfterMinor: text("balance_after_minor").notNull(),
		sourceType: text("source_type", {
			enum: ["earned", "hold", "release", "refund", "reversal"],
		}).notNull(),
		sourceId: text("source_id").notNull(),
		idempotencyKey: text("idempotency_key").notNull().unique(),
		createdAt: integer("created_at").notNull(),
	},
	(t) => [
		index("reward_entries_user_created_idx").on(t.userId, t.createdAt, t.id),
	],
);
export const orderBalanceHolds = sqliteTable("order_balance_holds", {
	orderId: text("order_id")
		.primaryKey()
		.references(() => shopOrders.id),
	userId: text("user_id")
		.notNull()
		.references(() => users.id),
	cashMinor: text("cash_minor").notNull(),
	rewardMinor: text("reward_minor").notNull(),
	externalMinor: text("external_minor").notNull(),
	state: text("state", { enum: ["held", "consumed", "released"] })
		.notNull()
		.default("held"),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});
export const promotionRewards = sqliteTable(
	"promotion_rewards",
	{
		orderId: text("order_id")
			.primaryKey()
			.references(() => shopOrders.id),
		userId: text("user_id")
			.notNull()
			.references(() => users.id),
		amountMinor: text("amount_minor").notNull(),
		remainingMinor: text("remaining_minor").notNull(),
		state: text("state", { enum: ["pending", "available", "reversed"] })
			.notNull()
			.default("pending"),
		availableAt: integer("available_at"),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
	},
	(t) => [
		index("promotion_rewards_settle_idx").on(t.state, t.availableAt, t.orderId),
		index("promotion_rewards_user_created_idx").on(
			t.userId,
			t.createdAt,
			t.orderId,
		),
	],
);
