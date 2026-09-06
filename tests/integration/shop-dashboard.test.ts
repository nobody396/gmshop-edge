import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryAdminDashboard } from "#/features/dashboard/server/query";
import {
	createDatastoreCounters,
	instrumentD1,
} from "../helpers/datastore-counters";
import { applyMigrations } from "./migrations";

describe("shop dashboard", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let database: D1Database;

	beforeAll(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		database = await miniflare.getD1Database("DB");
		await applyMigrations(database);
		await seed(database);
	});

	afterAll(async () => miniflare.dispose());

	it("returns commerce, inventory and fulfillment metrics in one batch", async () => {
		const counters = createDatastoreCounters();
		const dashboard = await queryAdminDashboard(
			instrumentD1(database, counters),
			Date.now(),
		);
		expect(counters).toMatchObject({ d1Batch: 1, d1Prepare: 4 });
		expect(dashboard.summary).toEqual({
			orders: 2,
			customers: 1,
			availableInventory: 1,
			lowStock: 1,
			pendingDelivery: 1,
			failedBuilds: 0,
		});
		expect(dashboard.sales).toEqual([
			{
				amountMinor: "1299",
				averageOrderMinor: "1299",
				costMinor: "499",
				currency: "USD",
				currencyDecimals: 2,
				grossProfitMinor: "600",
				netMinor: "1099",
				orderCount: 1,
				refundMinor: "200",
			},
		]);
		expect(dashboard.performance).toMatchObject({
			costCoverageBps: 10_000,
			newCustomers: 1,
			ordersCreated: 1,
			repeatCustomerBps: 10_000,
		});
	});

	it("uses the Asia/Shanghai calendar day for today's metrics", async () => {
		const boundaryMiniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		const boundaryDatabase = await boundaryMiniflare.getD1Database("DB");
		await applyMigrations(boundaryDatabase);
		await seedBeijingDayBoundary(boundaryDatabase);

		try {
			const dashboard = await queryAdminDashboard(
				boundaryDatabase,
				Date.parse("2026-09-06T12:00:00.000Z"),
				1,
			);

			expect(dashboard.sales).toEqual([
				{
					amountMinor: "1000",
					averageOrderMinor: "1000",
					costMinor: "700",
					currency: "CNY",
					currencyDecimals: 2,
					grossProfitMinor: "300",
					netMinor: "1000",
					orderCount: 1,
					refundMinor: "0",
				},
			]);
			expect(dashboard.performance).toMatchObject({
				costCoverageBps: 10_000,
				ordersCreated: 1,
			});
			expect(dashboard.dailyOrders).toEqual([
				{ day: "2026-09-06", orderCount: 1, paidCount: 1 },
			]);
		} finally {
			await boundaryMiniflare.dispose();
		}
	});
});

async function seedBeijingDayBoundary(db: D1Database) {
	const insideBeijingToday = Date.parse("2026-09-05T16:01:00.000Z");
	const outsideBeijingToday = Date.parse("2026-09-05T15:59:00.000Z");
	await db.batch([
		db
			.prepare(
				`INSERT INTO products
				 (id, name, product_type, status, sort_order, created_at, updated_at)
				 VALUES ('boundary-product', 'Boundary product',
				  'stock', 'active', 1, ?, ?)`,
			)
			.bind(outsideBeijingToday, outsideBeijingToday),
		db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, currency, currency_decimals,
				  price_minor, cost_minor, minimum_quantity, maximum_quantity,
				  sort_order, enabled, created_at, updated_at)
				 VALUES ('boundary-item', 'boundary-product', 'Default', 'CNY', 2,
				  '1000', '700', 1, 1, 1, 1, ?, ?)`,
			)
			.bind(outsideBeijingToday, outsideBeijingToday),
		...[
			["inside", insideBeijingToday, "1000", "700"],
			["outside", outsideBeijingToday, "9000", "100"],
		].flatMap(([key, createdAt, price, cost]) => [
			db
				.prepare(
					`INSERT INTO shop_orders
					 (id, order_number, status, currency, currency_decimals, subtotal_minor,
					  discount_minor, total_minor, paid_minor, version, expires_at, paid_at,
					  created_at, updated_at)
					 VALUES (?, ?, 'paid', 'CNY', 2, ?, '0', ?, ?, 2, ?, ?, ?, ?)`,
				)
				.bind(
					`boundary-order-${key}`,
					`GM-BOUNDARY-${key}`,
					price,
					price,
					price,
					Number(createdAt) + 900_000,
					createdAt,
					createdAt,
					createdAt,
				),
			db
				.prepare(
					`INSERT INTO shop_order_items
					 (id, order_id, product_id, sellable_item_id, product_name,
					  delivery_component_id, delivery_component_type, delivery_component_version,
					  sellable_item_name, quantity, unit_price_minor, unit_cost_minor,
					  discount_minor, subtotal_minor, created_at, updated_at)
					 VALUES (?, ?, 'boundary-product', 'boundary-item', 'Boundary product',
					  'boundary-item', 'stock', 1, 'Default', 1, ?, ?, '0', ?, ?, ?)`,
				)
				.bind(
					`boundary-order-item-${key}`,
					`boundary-order-${key}`,
					price,
					cost,
					price,
					createdAt,
					createdAt,
				),
		]),
	]);
}

async function seed(db: D1Database) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`INSERT INTO products
			 (id, name, product_type, status, sort_order, created_at, updated_at)
			 VALUES ('dash-product', 'Dashboard product',
			  'stock', 'active', 1, ?, ?)`,
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO product_sellable_items
				 (id, product_id, name, currency, currency_decimals,
				  price_minor, cost_minor, minimum_quantity, maximum_quantity,
				  sort_order, enabled, created_at, updated_at)
				 VALUES ('dash-sellableItem', 'dash-product', 'Default', 'USD', 2,
				  '1299', '499', 1, 1, 1, 1, ?, ?)`,
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO users
			 (id, name, email, email_verified, created_at, updated_at)
			 VALUES ('dash-customer', 'Dashboard customer', 'buyer@example.com', 1, ?, ?)`,
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO shop_orders
			 (id, order_number, user_id, contact_email,
			  normalized_contact_email, status, currency, currency_decimals, subtotal_minor,
			  discount_minor, total_minor, paid_minor, version, expires_at, created_at, updated_at)
			 VALUES ('dash-order', 'GM-DASH-1', 'dash-customer', 'buyer@example.com',
			  'buyer@example.com', 'paid', 'USD', 2, '1299', '0', '1299', '1299', 2, ?, ?, ?)`,
			)
			.bind(now + 900_000, now, now),
		db
			.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, user_id, contact_email,
				  normalized_contact_email, status, currency, currency_decimals, subtotal_minor,
				  discount_minor, total_minor, paid_minor, version, expires_at, paid_at,
				  refunded_at, created_at, updated_at)
				 VALUES ('dash-old-order', 'GM-DASH-OLD', 'dash-customer',
				  'buyer@example.com', 'buyer@example.com', 'refunded', 'USD', 2,
				  '500', '0', '500', '500', 4, ?, ?, ?, ?, ?)`,
			)
			.bind(
				now - 40 * 86_400_000 + 900_000,
				now - 40 * 86_400_000,
				now,
				now - 40 * 86_400_000,
				now,
			),
		db
			.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
				  delivery_component_type, delivery_component_version,
				  sellable_item_name, quantity, unit_price_minor, unit_cost_minor, discount_minor,
				  subtotal_minor, created_at, updated_at)
				 VALUES ('dash-item', 'dash-order', 'dash-product', 'dash-sellableItem', 'Dashboard product',
				  'dash-sellableItem', 'stock', 1, 'Default', 1, '1299', '499', '0', '1299', ?, ?)`,
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO refunds
			 (id, order_id, idempotency_key, amount_minor, currency,
			  payment_amount_minor, payment_currency, payment_currency_decimals,
			  order_status_before, status, reason, attempt_count, completed_at,
			  created_at, updated_at)
			 VALUES ('dash-refund', 'dash-old-order', 'dash-refund-key', '200', 'USD',
			  '200', 'USD', 2, 'paid', 'succeeded', 'Old order refunded now', 1, ?, ?, ?)`,
			)
			.bind(now, now, now),
		db
			.prepare(
				`INSERT INTO stock_entries
				 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint, content_mask,
				  status, created_at, updated_at)
				 VALUES ('dash-card', 'dash-sellableItem', 'encrypted', 1, 'fingerprint', '****', 'available', ?, ?)`,
			)
			.bind(now, now),
		db
			.prepare(
				`INSERT INTO delivery_records
			 (id, order_item_id, delivery_type, status, attempt_count, created_at, updated_at)
			 VALUES ('dash-delivery', 'dash-item', 'stock', 'pending', 0, ?, ?)`,
			)
			.bind(now, now),
	]);
}
