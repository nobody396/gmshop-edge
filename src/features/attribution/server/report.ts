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

export type ChannelReportRow = {
	date: string;
	channel: string;
	currency: string;
	orders: number;
	paidOrders: number;
	paidAmountMinor: string;
};

export type CampaignReportRow = ChannelReportRow & {
	utmSource: string | null;
	utmMedium: string | null;
	utmCampaign: string | null;
};

type Touchpoint = "first" | "last";

// Last touch falls back to the first touch when no later non-direct landing was
// recorded (no last-touch cookie, or orders placed before it existed).
const touchColumns: Record<
	Touchpoint,
	{ channel: string; source: string; medium: string; campaign: string }
> = {
	first: {
		channel: "COALESCE(a.source_category, 'unattributed')",
		source: "a.utm_source",
		medium: "a.utm_medium",
		campaign: "a.utm_campaign",
	},
	last: {
		channel:
			"COALESCE(a.last_source_category, a.source_category, 'unattributed')",
		source:
			"CASE WHEN a.last_source_category IS NULL THEN a.utm_source ELSE a.last_utm_source END",
		medium:
			"CASE WHEN a.last_source_category IS NULL THEN a.utm_medium ELSE a.last_utm_medium END",
		campaign:
			"CASE WHEN a.last_source_category IS NULL THEN a.utm_campaign ELSE a.last_utm_campaign END",
	},
};

const paidStatuses = "('paid','fulfilling','completed')";

function addAmounts(left: string, right: string) {
	return (BigInt(left) + BigInt(right)).toString();
}

/** Sums rows into "total" rows keyed by everything except the date. */
function totalsOf<T extends ChannelReportRow>(
	rows: T[],
	keyOf: (row: T) => string,
) {
	const totals = new Map<string, T>();
	for (const row of rows) {
		const key = keyOf(row);
		const total = totals.get(key);
		if (!total) {
			totals.set(key, { ...row, date: "total" });
			continue;
		}
		total.orders += row.orders;
		total.paidOrders += row.paidOrders;
		total.paidAmountMinor = addAmounts(
			total.paidAmountMinor,
			row.paidAmountMinor,
		);
	}
	return [...totals.values()].sort(
		(left, right) =>
			right.paidOrders - left.paidOrders ||
			left.channel.localeCompare(right.channel),
	);
}

async function loadTouchpointReport(
	db: D1Database,
	touchpoint: Touchpoint,
	since: number,
) {
	const column = touchColumns[touchpoint];
	const result = await db
		.prepare(
			`SELECT date((o.created_at + ?) / 1000, 'unixepoch') AS day,
			        ${column.channel} AS touch_channel,
			        ${column.source} AS touch_source,
			        ${column.medium} AS touch_medium,
			        ${column.campaign} AS touch_campaign,
			        o.currency,
			        COUNT(*) AS orders,
			        SUM(CASE WHEN o.status IN ${paidStatuses} THEN 1 ELSE 0 END) AS paid_orders,
			        SUM(CASE WHEN o.status IN ${paidStatuses}
			                 THEN CAST(o.total_minor AS INTEGER) ELSE 0 END) AS paid_amount_minor
			 FROM shop_orders o
			 LEFT JOIN order_attribution a ON a.order_id = o.id
			 WHERE o.created_at >= ?
			 GROUP BY day, touch_channel, touch_source, touch_medium, touch_campaign, o.currency
			 ORDER BY day DESC, touch_channel, touch_source, touch_medium, touch_campaign, o.currency`,
		)
		.bind(BEIJING_OFFSET_MS, since)
		.all<{
			day: string;
			touch_channel: string;
			touch_source: string | null;
			touch_medium: string | null;
			touch_campaign: string | null;
			currency: string;
			orders: number;
			paid_orders: number;
			paid_amount_minor: number;
		}>();
	const campaignRows: CampaignReportRow[] = result.results.map((row) => ({
		date: row.day,
		channel: row.touch_channel,
		utmSource: row.touch_source,
		utmMedium: row.touch_medium,
		utmCampaign: row.touch_campaign,
		currency: row.currency,
		orders: Number(row.orders),
		paidOrders: Number(row.paid_orders),
		paidAmountMinor: String(row.paid_amount_minor ?? 0),
	}));
	const channelKey = (row: ChannelReportRow) =>
		`${row.date}\u0000${row.channel}\u0000${row.currency}`;
	const channelRows: ChannelReportRow[] = [];
	const byDayChannel = new Map<string, ChannelReportRow>();
	for (const row of campaignRows) {
		const key = channelKey(row);
		const existing = byDayChannel.get(key);
		if (existing) {
			existing.orders += row.orders;
			existing.paidOrders += row.paidOrders;
			existing.paidAmountMinor = addAmounts(
				existing.paidAmountMinor,
				row.paidAmountMinor,
			);
			continue;
		}
		const channelRow = {
			date: row.date,
			channel: row.channel,
			currency: row.currency,
			orders: row.orders,
			paidOrders: row.paidOrders,
			paidAmountMinor: row.paidAmountMinor,
		};
		byDayChannel.set(key, channelRow);
		channelRows.push(channelRow);
	}
	channelRows.sort(
		(left, right) =>
			right.date.localeCompare(left.date) ||
			left.channel.localeCompare(right.channel) ||
			left.currency.localeCompare(right.currency),
	);
	return {
		byChannel: {
			rows: channelRows,
			totals: totalsOf(
				channelRows,
				(row) => `${row.channel}\u0000${row.currency}`,
			),
		},
		byCampaign: {
			rows: campaignRows,
			totals: totalsOf(campaignRows, (row) =>
				[
					row.channel,
					row.utmSource,
					row.utmMedium,
					row.utmCampaign,
					row.currency,
				].join("\u0000"),
			),
		},
	};
}

/**
 * Orders per Beijing calendar day and source. `rows`/`totals` keep the original
 * first-touch category shape. `firstTouch` and `lastTouch` group the same orders
 * by channel (`byChannel`) and by channel + utm source/medium/campaign
 * (`byCampaign`), each per day (`rows`) and over the whole window (`totals`).
 * "Paid" counts orders whose payment settled (paid, fulfilling, completed);
 * refunds and unpaid orders only appear in `orders`. Orders created before the
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
	const [firstTouch, lastTouch] = await Promise.all([
		loadTouchpointReport(db, "first", since),
		loadTouchpointReport(db, "last", since),
	]);
	const rows: AttributionReportRow[] = firstTouch.byChannel.rows.map(
		({ channel, ...row }) => ({ ...row, category: channel }),
	);
	const totals: AttributionReportRow[] = firstTouch.byChannel.totals.map(
		({ channel, ...row }) => ({ ...row, category: channel }),
	);
	return {
		ok: true as const,
		days,
		timezone: "Asia/Shanghai",
		since: new Date(since).toISOString(),
		rows,
		totals,
		firstTouch,
		lastTouch,
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
