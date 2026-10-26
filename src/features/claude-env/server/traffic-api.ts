import { ZodError, z } from "zod";
import { requireRestockAuthorization } from "#/features/catalog/server/restock-api";
import { DomainError } from "#/lib/domain-error";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import {
	formatGb,
	gbBytes,
	iproyalIncludedBytes,
	maskEmail,
	trafficPeriodStart,
} from "../domain";
import { type Deliver, defaultDeliver, eventStatement } from "./shared";
import { snapshotOf, trafficSnapshots } from "./traffic";

/**
 * Traffic jobs for the IPRoyal buyer CLI — Bearer RESTOCK_API_TOKEN:
 *   GET  /api/ops/claude-env/traffic            current-period numbers per subscription
 *   POST /api/ops/claude-env/traffic/purchases  purchases made (idempotent on ref) and usage readings
 * GMShop never decides when to buy; the CLI does.
 */
export type TrafficOpsRoute = "list" | "purchases";

const maxBodyBytes = 100_000;

const iproyalOrderId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
/** Unix milliseconds or an ISO 8601 timestamp with zone. */
const at = z
	.union([
		z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		z.string().datetime({ offset: true }),
	])
	.transform((value) =>
		typeof value === "number" ? value : Date.parse(value),
	);

export const trafficReportSchema = z
	.object({
		purchases: z
			.array(
				z.object({
					iproyalOrderId,
					gb: z.number().int().positive().max(100_000),
					costUsd: z
						.number()
						.nonnegative()
						.max(1_000_000)
						.nullable()
						.optional(),
					ref: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/),
					at,
				}),
			)
			.max(50)
			.default([]),
		usage: z
			.array(
				z.object({
					iproyalOrderId,
					usedBytes: z
						.number()
						.int()
						.nonnegative()
						.max(Number.MAX_SAFE_INTEGER),
					at,
				}),
			)
			.max(500)
			.default([]),
	})
	.refine((body) => body.purchases.length + body.usage.length > 0, {
		message: "empty_report",
	});
export type TrafficReport = z.output<typeof trafficReportSchema>;

const iso = (ms: number) => new Date(ms).toISOString();

export async function listTrafficJobs(db: D1Database, now: number) {
	const rows = await db
		.prepare(
			`SELECT id, iproyal_order_id, ip, activated_at, expires_at, traffic_period_start, traffic_period_bytes,
			 traffic_quota_bytes, upstream_used_bytes, upstream_used_at
			 FROM claude_env_subscriptions
			 WHERE status = 'active' AND activated_at IS NOT NULL AND iproyal_order_id IS NOT NULL
			 ORDER BY activated_at LIMIT 1000`,
		)
		.all<{
			id: string;
			iproyal_order_id: string;
			ip: string | null;
			activated_at: number;
			expires_at: number | null;
			traffic_period_start: number | null;
			traffic_period_bytes: number;
			traffic_quota_bytes: number;
			upstream_used_bytes: number | null;
			upstream_used_at: number | null;
		}>();
	const snapshots = await trafficSnapshots(db, rows.results, now);
	return {
		generatedAt: iso(now),
		includedBytesPerCycle: iproyalIncludedBytes,
		subscriptions: rows.results.flatMap((row) => {
			const snapshot = snapshots.get(row.id);
			if (!snapshot) return [];
			return [
				{
					subscriptionId: row.id,
					iproyalOrderId: row.iproyal_order_id,
					ip: row.ip,
					periodStart: iso(snapshot.periodStart),
					periodEnd: iso(snapshot.periodEnd),
					expiresAt: row.expires_at === null ? null : iso(row.expires_at),
					entitledBytes: snapshot.entitledBytes,
					relayUsedBytes: snapshot.usedBytes,
					upstreamPurchasedBytes: snapshot.upstreamPurchasedBytes,
					upstreamCapacityBytes: snapshot.upstreamCapacityBytes,
					upstreamUsedBytes: row.upstream_used_bytes,
					upstreamUsedAt:
						row.upstream_used_at === null ? null : iso(row.upstream_used_at),
				},
			];
		}),
	};
}

type SubForOrder = {
	id: string;
	email: string;
	activated_at: number | null;
};

async function subscriptionForOrder(db: D1Database, orderId: string) {
	return db
		.prepare(
			"SELECT id, email, activated_at FROM claude_env_subscriptions WHERE iproyal_order_id = ? ORDER BY created_at DESC LIMIT 1",
		)
		.bind(orderId)
		.first<SubForOrder>();
}

export async function recordTrafficReport(
	db: D1Database,
	report: TrafficReport,
	now: number,
	deliver: Deliver,
) {
	const purchases: Array<{
		ref: string;
		status: "recorded" | "duplicate";
		subscriptionId: string | null;
	}> = [];
	for (const purchase of report.purchases) {
		const sub = await subscriptionForOrder(db, purchase.iproyalOrderId);
		const purchasedAt = Math.min(purchase.at, now);
		const periodStart =
			sub?.activated_at != null
				? trafficPeriodStart(sub.activated_at, purchasedAt)
				: null;
		const bytes = purchase.gb * gbBytes;
		const costCents =
			purchase.costUsd === undefined || purchase.costUsd === null
				? null
				: Math.round(purchase.costUsd * 100);
		const inserted = await db
			.prepare(
				`INSERT INTO claude_env_upstream_purchases
				 (ref, iproyal_order_id, subscription_id, period_start, gb, bytes, cost_usd_cents, purchased_at, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ref) DO NOTHING`,
			)
			.bind(
				purchase.ref,
				purchase.iproyalOrderId,
				sub?.id ?? null,
				periodStart,
				purchase.gb,
				bytes,
				costCents,
				purchasedAt,
				now,
			)
			.run();
		if (Number(inserted.meta.changes ?? 0) !== 1) {
			purchases.push({
				ref: purchase.ref,
				status: "duplicate",
				subscriptionId: sub?.id ?? null,
			});
			continue;
		}
		purchases.push({
			ref: purchase.ref,
			status: "recorded",
			subscriptionId: sub?.id ?? null,
		});
		const cost =
			costCents === null ? "" : `（$${(costCents / 100).toFixed(2)}）`;
		if (sub) {
			await eventStatement(
				db,
				sub.id,
				"upstream_traffic_bought",
				`IPRoyal #${purchase.iproyalOrderId} +${purchase.gb} GB${cost} ref ${purchase.ref}`,
				now,
			).run();
			const snapshot = await snapshotOf(db, sub.id, now);
			await deliver(
				[
					`✅ IPRoyal 加流量已回报：订单 #${purchase.iproyalOrderId} +${purchase.gb} GB${cost}`,
					`客户 ${maskEmail(sub.email)}${
						snapshot
							? `｜本期 IPRoyal 容量 ${formatGb(snapshot.upstreamCapacityBytes)}，客户应得 ${formatGb(snapshot.entitledBytes)}，已用 ${formatGb(snapshot.usedBytes)}`
							: ""
					}`,
				].join("\n"),
			).catch(() => undefined);
		} else
			await deliver(
				`⚠️ 流量采购程序回报了一笔 IPRoyal 加流量（订单 #${purchase.iproyalOrderId} +${purchase.gb} GB${cost}），但这个订单不属于任何 Claude 专属环境订阅。请核对。`,
			).catch(() => undefined);
	}
	const usage: Array<{
		iproyalOrderId: string;
		status: "recorded" | "stale" | "unknown_order";
	}> = [];
	for (const reading of report.usage) {
		const readAt = Math.min(reading.at, now);
		const result = await db
			.prepare(
				`UPDATE claude_env_subscriptions SET upstream_used_bytes = ?, upstream_used_at = ?
				 WHERE id = (SELECT id FROM claude_env_subscriptions WHERE iproyal_order_id = ? ORDER BY created_at DESC LIMIT 1)
				 AND (upstream_used_at IS NULL OR upstream_used_at <= ?)`,
			)
			.bind(reading.usedBytes, readAt, reading.iproyalOrderId, readAt)
			.run();
		usage.push({
			iproyalOrderId: reading.iproyalOrderId,
			status:
				Number(result.meta.changes ?? 0) === 1
					? "recorded"
					: (await subscriptionForOrder(db, reading.iproyalOrderId))
						? "stale"
						: "unknown_order",
		});
	}
	return { purchases, usage };
}

export async function handleClaudeEnvTrafficOps(
	request: Request,
	env: CloudflareBindings,
	route: TrafficOpsRoute,
	options: { now?: number; deliver?: Deliver } = {},
) {
	try {
		const db = env.DB;
		if (!db || !env.RESTOCK_API_TOKEN)
			throw new DomainError(
				"claude_env_traffic_api_unavailable",
				503,
				"Traffic API unavailable",
			);
		await requireRestockAuthorization(request, db, env.RESTOCK_API_TOKEN);
		const now = options.now ?? Date.now();
		const budget = await claimFixedWindowRateLimit(db, {
			bucketKey: `claude-env-traffic-api:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
			limit: 60,
			windowMs: 60_000,
			now,
		});
		if (!budget.allowed)
			throw new DomainError(
				"claude_env_traffic_rate_limited",
				429,
				"Rate limit exceeded",
			);
		if (route === "list") {
			if (request.method !== "GET") return methodNotAllowed("GET");
			return json({ ok: true, ...(await listTrafficJobs(db, now)) }, 200);
		}
		if (request.method !== "POST") return methodNotAllowed("POST");
		if (Number(request.headers.get("content-length") ?? "0") > maxBodyBytes)
			throw new DomainError("claude_env_traffic_too_large", 413, "Too large");
		const text = await request.text();
		if (text.length > maxBodyBytes)
			throw new DomainError("claude_env_traffic_too_large", 413, "Too large");
		const report = trafficReportSchema.parse(JSON.parse(text));
		return json(
			{
				ok: true,
				...(await recordTrafficReport(
					db,
					report,
					now,
					options.deliver ?? defaultDeliver(db, fetch),
				)),
			},
			200,
		);
	} catch (error) {
		if (error instanceof DomainError)
			return json({ ok: false, error: error.code }, error.status);
		if (error instanceof ZodError || error instanceof SyntaxError)
			return json({ ok: false, error: "invalid_request" }, 400);
		return json({ ok: false, error: "internal_error" }, 500);
	}
}

function methodNotAllowed(allow: string) {
	return new Response(
		JSON.stringify({ ok: false, error: "method_not_allowed" }),
		{
			status: 405,
			headers: {
				Allow: allow,
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "no-store",
			},
		},
	);
}

function json(payload: unknown, status: number) {
	return Response.json(payload, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
