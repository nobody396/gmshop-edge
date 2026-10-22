import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { productSellableItems } from "./commerce";
import { timestamps } from "./common";

const moneyCheck = (column: { name: string }) =>
	sql.raw(`"${column.name}" <> '' AND "${column.name}" NOT GLOB '*[^0-9]*'`);

/**
 * Public volume pricing (see drizzle/0043): buying at least `min_quantity`
 * takes `discount_minor` off every unit, on every payment channel's price, so
 * the steps follow list-price changes made by the pricing guard.
 */
export const sellableItemVolumePrices = sqliteTable(
	"sellable_item_volume_prices",
	{
		sellableItemId: text("sellable_item_id")
			.notNull()
			.references(() => productSellableItems.id, { onDelete: "cascade" }),
		minQuantity: integer("min_quantity").notNull(),
		discountMinor: text("discount_minor").notNull(),
		...timestamps,
	},
	(table) => [
		primaryKey({ columns: [table.sellableItemId, table.minQuantity] }),
		check(
			"sellable_item_volume_prices_min_quantity_check",
			sql`${table.minQuantity} BETWEEN 2 AND 1000`,
		),
		check(
			"sellable_item_volume_prices_discount_check",
			moneyCheck(table.discountMinor),
		),
	],
);

/**
 * A price agreed with one registered customer (see drizzle/0043). It does not
 * follow list-price changes. `price_minor` is the base (USDT/balance) unit
 * price; other channels add their usual difference from the base price unless
 * `channel_prices_json` names a price for that channel.
 */
export const customerItemPrices = sqliteTable(
	"customer_item_prices",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		sellableItemId: text("sellable_item_id")
			.notNull()
			.references(() => productSellableItems.id, { onDelete: "cascade" }),
		minQuantity: integer("min_quantity").notNull().default(1),
		priceMinor: text("price_minor").notNull(),
		channelPricesJson: text("channel_prices_json", { mode: "json" })
			.$type<Record<string, string>>()
			.notNull()
			.default(sql`'{}'`),
		costMinorAtSet: text("cost_minor_at_set"),
		createdBy: text("created_by"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("customer_item_prices_scope_uidx").on(
			table.userId,
			table.sellableItemId,
			table.minQuantity,
		),
		index("customer_item_prices_item_idx").on(table.sellableItemId),
		check(
			"customer_item_prices_min_quantity_check",
			sql`${table.minQuantity} BETWEEN 1 AND 1000`,
		),
		check("customer_item_prices_price_check", moneyCheck(table.priceMinor)),
		check(
			"customer_item_prices_channel_prices_check",
			sql`json_valid(${table.channelPricesJson}) AND json_type(${table.channelPricesJson}) = 'object'`,
		),
	],
);

export const bulkProcurementStates = [
	"pending",
	"verifying",
	"awaiting_funds",
	"awaiting_stock",
	"awaiting_price",
	"supplied",
	"review",
	"skipped",
	"cancelled",
] as const;

/**
 * One bulk sale (an order line of several owned codes) whose cards the redeem
 * warehouse buys from AISOU in one wholesale trade (see drizzle/0043).
 */
export const bulkProcurements = sqliteTable(
	"bulk_procurements",
	{
		id: text("id").primaryKey(),
		orderId: text("order_id").notNull(),
		orderItemId: text("order_item_id").notNull(),
		sellableItemId: text("sellable_item_id").notNull(),
		warehouseSku: text("warehouse_sku").notNull(),
		quantity: integer("quantity").notNull(),
		codeHashesJson: text("code_hashes_json", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		state: text("state", { enum: bulkProcurementStates })
			.notNull()
			.default("pending"),
		acceptUnitMinor: text("accept_unit_minor"),
		lastResultJson: text("last_result_json"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: integer("next_attempt_at").notNull().default(0),
		notifiedState: text("notified_state"),
		ownerActionId: text("owner_action_id"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("bulk_procurements_order_item_uidx").on(table.orderItemId),
		index("bulk_procurements_state_idx").on(table.state, table.nextAttemptAt),
		check(
			"bulk_procurements_state_check",
			sql.raw(
				`"state" IN (${bulkProcurementStates.map((state) => `'${state}'`).join(",")})`,
			),
		),
		check(
			"bulk_procurements_code_hashes_check",
			sql`json_valid(${table.codeHashesJson}) AND json_type(${table.codeHashesJson}) = 'array'`,
		),
	],
);
