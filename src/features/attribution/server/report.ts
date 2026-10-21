import { z } from "zod";
import { requireRestockAuthorization } from "#/features/catalog/server/restock-api";
import { DomainError } from "#/lib/domain-error";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";

const BEIJING_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

const querySchema = z.object({
	days: z.coerce.number().int().min(1).max(366).default(30),
});

export type AttributionReportRow = {
	date: string;
	category: string;
	currency: string;
	orders: number;
	paidOrders: number;
	paidAmountMinor: string;
};

/**
 * Orders per Beijing calendar day and first-touch source category. "Paid"
 * counts orders whose payment settled (paid, fulfilling, completed); refunds
 * and unpaid orders only appear in `orders`. Orders created before the
 * attribution table existed report as "unattributed".
 */
export async function loadAttributionReport(
	db: D1Database,
	days: number,
	now = Date.now(),
) {
	const todayStart =
		Math.floor((now + BEIJING_OFFSET_MS) / DAY_MS) * DAY_MS - BEIJING_OFFSET_MS;
	const since = todayStart - (days - 1) * DAY_MS;
	const result = await db
		.prepare(
			`SELECT date((o.created_at + ?) / 1000, 'unixepoch') AS day,
			        COALESCE(a.source_category, 'unattributed') AS category,
			        o.currency,
			        COUNT(*) AS orders,
			        SUM(CASE WHEN o.status IN ('paid','fulfilling','completed') THEN 1 ELSE 0 END) AS paid_orders,
			        SUM(CASE WHEN o.status IN ('paid','fulfilling','completed')
			                 THEN CAST(o.total_minor AS INTEGER) ELSE 0 END) AS paid_amount_minor
			 FROM shop_orders o
			 LEFT JOIN order_attribution a ON a.order_id = o.id
			 WHERE o.created_at >= ?
			 GROUP BY day, category, o.currency
			 ORDER BY day DESC, category, o.currency`,
		)
		.bind(BEIJING_OFFSET_MS, since)
		.all<{
			day: string;
			category: string;
			currency: string;
			orders: number;
			paid_orders: number;
			paid_amount_minor: number;
		}>();
	const rows: AttributionReportRow[] = result.results.map((row) => ({
		date: row.day,
		category: row.category,
		currency: row.currency,
		orders: Number(row.orders),
		paidOrders: Number(row.paid_orders),
		paidAmountMinor: String(row.paid_amount_minor ?? 0),
	}));
	const totals = new Map<string, AttributionReportRow>();
	for (const row of rows) {
		const key = `${row.category}\u0000${row.currency}`;
		const total = totals.get(key) ?? {
			date: "total",
			category: row.category,
			currency: row.currency,
			orders: 0,
			paidOrders: 0,
			paidAmountMinor: "0",
		};
		total.orders += row.orders;
		total.paidOrders += row.paidOrders;
		total.paidAmountMinor = (
			BigInt(total.paidAmountMinor) + BigInt(row.paidAmountMinor)
		).toString();
		totals.set(key, total);
	}
	return {
		ok: true as const,
		days,
		timezone: "Asia/Shanghai",
		since: new Date(since).toISOString(),
		rows,
		totals: [...totals.values()].sort(
			(left, right) =>
				right.paidOrders - left.paidOrders ||
				left.category.localeCompare(right.category),
		),
	};
}

/** GET /api/ops/attribution?days=N — Bearer RESTOCK_API_TOKEN, read-only. */
export async function handleAttributionReportRequest(
	request: Request,
	env: CloudflareBindings,
) {
	try {
		const db = env.DB;
		if (!db || !env.RESTOCK_API_TOKEN)
			throw new DomainError(
				"attribution_api_unavailable",
				503,
				"Attribution API unavailable",
			);
		if (request.method !== "GET")
			return new Response(null, { status: 405, headers: { Allow: "GET" } });
		await requireRestockAuthorization(request, db, env.RESTOCK_API_TOKEN);
		const budget = await claimFixedWindowRateLimit(db, {
			bucketKey: `attribution-api:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
			limit: 20,
			windowMs: 60_000,
			now: Date.now(),
		});
		if (!budget.allowed)
			throw new DomainError(
				"attribution_rate_limited",
				429,
				"Rate limit exceeded",
			);
		const query = querySchema.safeParse(
			Object.fromEntries(new URL(request.url).searchParams),
		);
		if (!query.success)
			throw new DomainError("attribution_invalid", 400, "Invalid query");
		return json(await loadAttributionReport(db, query.data.days), 200);
	} catch (error) {
		if (error instanceof DomainError)
			return json({ ok: false, error: error.code }, error.status);
		return json({ ok: false, error: "attribution_failed" }, 500);
	}
}

function json(payload: unknown, status: number) {
	return Response.json(payload, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
