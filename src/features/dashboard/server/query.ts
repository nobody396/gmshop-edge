type Summary = {
	orders: number;
	customers: number;
	available_inventory: number;
	low_stock: number;
	pending_delivery: number;
	failed_builds: number;
	default_currency: string;
	default_currency_decimals: number;
};

type SalesRow = {
	currency: string;
	currency_decimals: number;
	amount_minor: string;
	refund_minor: string;
	cost_minor: string;
	order_count: number;
};

type DailyOrder = { day: string; order_count: number; paid_count: number };

const DAY_MS = 86_400_000;
const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

export async function queryAdminDashboard(
	db: D1Database,
	now = Date.now(),
	days = 14,
) {
	const rangeStart = startOfBeijingDay(now) - (days - 1) * DAY_MS;
	const [summaryResult, salesResult, dailyResult, performanceResult] =
		await db.batch([
			db.prepare(
				`SELECT
			 (SELECT COUNT(*) FROM shop_orders) AS orders,
			 (SELECT COUNT(DISTINCT CASE WHEN user_id IS NOT NULL THEN 'u:' || user_id
			   ELSE 'e:' || normalized_contact_email END) FROM shop_orders
			  WHERE user_id IS NOT NULL OR normalized_contact_email IS NOT NULL) AS customers,
			 (SELECT COUNT(*) FROM stock_entries WHERE status = 'available') AS available_inventory,
			 (SELECT COUNT(*) FROM product_sellable_items item
			  JOIN products product ON product.id = item.product_id
			  WHERE item.enabled = 1 AND product.product_type = 'stock'
			   AND product.status = 'active'
			   AND (SELECT COUNT(*) FROM stock_entries secret
			    WHERE secret.sellable_item_id = item.id
			     AND secret.status = 'available') <= item.low_stock_threshold) AS low_stock,
			 (SELECT COUNT(*) FROM delivery_records WHERE status IN ('pending','processing','failed')) AS pending_delivery,
			 (SELECT COUNT(*) FROM automation_jobs WHERE status = 'failed') AS failed_builds,
			 COALESCE((SELECT json_extract(value, '$') FROM system_settings
			  WHERE key = 'commerce.default_currency'), 'USD') AS default_currency,
			 COALESCE((SELECT json_extract(value, '$') FROM system_settings
			  WHERE key = 'commerce.currency_decimals'), 2) AS default_currency_decimals`,
			),
			db
				.prepare(
					`WITH sales AS (
				 SELECT currency, currency_decimals,
				  SUM(CAST(total_minor AS INTEGER)) AS amount_minor,
				  COUNT(*) AS order_count
				 FROM shop_orders WHERE created_at >= ? AND CAST(paid_minor AS INTEGER) > 0
				 GROUP BY currency, currency_decimals
				), period_refunds AS (
				 SELECT r.currency, o.currency_decimals,
				  SUM(CAST(r.amount_minor AS INTEGER)) AS refund_minor
				 FROM refunds r JOIN shop_orders o ON o.id = r.order_id
				 WHERE r.status = 'succeeded' AND COALESCE(r.completed_at, r.updated_at) >= ?
				 GROUP BY r.currency, o.currency_decimals
				), costs AS (
				 SELECT o.currency, o.currency_decimals,
				  SUM(CASE WHEN oi.unit_cost_minor IS NULL THEN 0
				   ELSE CAST(oi.unit_cost_minor AS INTEGER) * oi.quantity END) AS cost_minor
				 FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
				 WHERE o.created_at >= ? AND CAST(o.paid_minor AS INTEGER) > 0
				 GROUP BY o.currency, o.currency_decimals
				), currencies AS (
				 SELECT currency, currency_decimals FROM sales
				 UNION SELECT currency, currency_decimals FROM period_refunds
				)
				 SELECT currencies.currency, currencies.currency_decimals,
				  COALESCE(sales.amount_minor, 0) AS amount_minor,
				  COALESCE(period_refunds.refund_minor, 0) AS refund_minor,
				  COALESCE(costs.cost_minor, 0) AS cost_minor,
				  COALESCE(sales.order_count, 0) AS order_count
				 FROM currencies
				 LEFT JOIN sales USING (currency, currency_decimals)
				 LEFT JOIN period_refunds USING (currency, currency_decimals)
				 LEFT JOIN costs USING (currency, currency_decimals)
				 ORDER BY currencies.currency`,
				)
				.bind(rangeStart, rangeStart, rangeStart),
			db
				.prepare(
					`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', '+8 hours') AS day,
				 COUNT(*) AS order_count,
					 SUM(CASE WHEN CAST(paid_minor AS INTEGER) > 0
					 THEN 1 ELSE 0 END) AS paid_count FROM shop_orders
				 WHERE created_at >= ? GROUP BY day ORDER BY day`,
				)
				.bind(rangeStart),
			db
				.prepare(
					`WITH paid_orders AS (
				 SELECT id, created_at,
				  CASE WHEN user_id IS NOT NULL THEN 'u:' || user_id
				   ELSE 'e:' || normalized_contact_email END AS customer_key
				 FROM shop_orders
				 WHERE CAST(paid_minor AS INTEGER) > 0
				  AND (user_id IS NOT NULL OR normalized_contact_email IS NOT NULL)
				) SELECT
			 (SELECT COUNT(*) FROM shop_orders WHERE created_at >= ?) AS orders_created,
			 ((SELECT COUNT(DISTINCT u.id) FROM users u
			   JOIN shop_orders customer_order ON customer_order.user_id = u.id
			   WHERE u.created_at >= ?)
			  + (SELECT COUNT(*) FROM (
			   SELECT normalized_contact_email FROM shop_orders
			   WHERE user_id IS NULL AND normalized_contact_email IS NOT NULL
			   GROUP BY normalized_contact_email HAVING MIN(created_at) >= ?
			  ))) AS new_customers,
			 (SELECT COUNT(*) FROM payment_attempts WHERE created_at >= ?) AS payment_attempts,
			 (SELECT COUNT(*) FROM payment_attempts WHERE created_at >= ? AND status = 'succeeded') AS successful_payments,
			 (SELECT COUNT(DISTINCT recent.customer_key) FROM paid_orders recent
			  WHERE recent.created_at >= ? AND EXISTS (
			   SELECT 1 FROM paid_orders prior WHERE prior.customer_key = recent.customer_key
			   AND (prior.created_at < recent.created_at OR
			    (prior.created_at = recent.created_at AND prior.id < recent.id)))) AS repeat_customers,
			 (SELECT COUNT(DISTINCT customer_key) FROM paid_orders
			  WHERE created_at >= ?) AS paying_customers,
				 (SELECT COALESCE(AVG(delivered_at - created_at), 0) FROM delivery_records
			  WHERE delivered_at IS NOT NULL AND created_at >= ?) AS fulfillment_ms,
				 (SELECT COALESCE(SUM(CASE WHEN oi.unit_cost_minor IS NOT NULL THEN oi.quantity ELSE 0 END), 0)
			  FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
			  WHERE o.created_at >= ? AND CAST(o.paid_minor AS INTEGER) > 0) AS costed_quantity,
				 (SELECT COALESCE(SUM(oi.quantity), 0)
			  FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
			  WHERE o.created_at >= ? AND CAST(o.paid_minor AS INTEGER) > 0) AS total_quantity`,
				)
				.bind(
					rangeStart,
					rangeStart,
					rangeStart,
					rangeStart,
					rangeStart,
					rangeStart,
					rangeStart,
					rangeStart,
					rangeStart,
					rangeStart,
				),
		]);
	const summary = summaryResult?.results[0] as Summary | undefined;
	const sales = ((salesResult?.results ?? []) as unknown as SalesRow[]).map(
		(row) => presentSales(row),
	);
	if (sales.length === 0)
		sales.push(
			presentSales({
				currency: String(summary?.default_currency ?? "USD"),
				currency_decimals: Number(summary?.default_currency_decimals ?? 2),
				amount_minor: "0",
				refund_minor: "0",
				cost_minor: "0",
				order_count: 0,
			}),
		);
	return {
		summary: {
			orders: Number(summary?.orders ?? 0),
			customers: Number(summary?.customers ?? 0),
			availableInventory: Number(summary?.available_inventory ?? 0),
			lowStock: Number(summary?.low_stock ?? 0),
			pendingDelivery: Number(summary?.pending_delivery ?? 0),
			failedBuilds: Number(summary?.failed_builds ?? 0),
		},
		sales,
		performance: presentPerformance(
			performanceResult?.results[0] as Record<string, unknown> | undefined,
		),
		dailyOrders: completeDailySeries(
			(dailyResult?.results ?? []) as unknown as DailyOrder[],
			rangeStart,
			days,
		),
	};
}

function presentSales(row: SalesRow) {
	return {
		currency: row.currency,
		currencyDecimals: Number(row.currency_decimals),
		amountMinor: String(row.amount_minor),
		refundMinor: String(row.refund_minor),
		netMinor: (BigInt(row.amount_minor) - BigInt(row.refund_minor)).toString(),
		costMinor: String(row.cost_minor),
		grossProfitMinor: (
			BigInt(row.amount_minor) -
			BigInt(row.refund_minor) -
			BigInt(row.cost_minor)
		).toString(),
		orderCount: Number(row.order_count),
		averageOrderMinor:
			Number(row.order_count) > 0
				? (BigInt(row.amount_minor) / BigInt(row.order_count)).toString()
				: "0",
	};
}

function presentPerformance(row: Record<string, unknown> | undefined) {
	const attempts = Number(row?.payment_attempts ?? 0);
	const successful = Number(row?.successful_payments ?? 0);
	const customers = Number(row?.paying_customers ?? 0);
	const repeat = Number(row?.repeat_customers ?? 0);
	const costedQuantity = Number(row?.costed_quantity ?? 0);
	const totalQuantity = Number(row?.total_quantity ?? 0);
	return {
		ordersCreated: Number(row?.orders_created ?? 0),
		newCustomers: Number(row?.new_customers ?? 0),
		paymentSuccessBps: attempts
			? Math.round((successful * 10_000) / attempts)
			: 0,
		repeatCustomerBps: customers
			? Math.round((repeat * 10_000) / customers)
			: 0,
		costCoverageBps: totalQuantity
			? Math.round((costedQuantity * 10_000) / totalQuantity)
			: 0,
		averageFulfillmentMs: Math.round(Number(row?.fulfillment_ms ?? 0)),
	};
}

function startOfBeijingDay(value: number) {
	const date = new Date(value + BEIJING_UTC_OFFSET_MS);
	return (
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
		BEIJING_UTC_OFFSET_MS
	);
}

function completeDailySeries(rows: DailyOrder[], start: number, days = 14) {
	const values = new Map(rows.map((row) => [row.day, row]));
	return Array.from({ length: days }, (_, index) => {
		const day = new Date(start + BEIJING_UTC_OFFSET_MS + index * DAY_MS)
			.toISOString()
			.slice(0, 10);
		const row = values.get(day);
		return {
			day,
			orderCount: Number(row?.order_count ?? 0),
			paidCount: Number(row?.paid_count ?? 0),
		};
	});
}
