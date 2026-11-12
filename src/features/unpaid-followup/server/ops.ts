import { z } from "zod";
import { constantTimeEqual } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { loadRuntimeConfig } from "#/server/runtime-config";
import {
	approvedFollowupSender,
	assessUnpaidOrder,
	loadFollowupOrder,
	renderFollowupFor,
	unpaidFollowupDelayMs,
	unpaidFollowupWindowEndMs,
} from "./scheduler";
import {
	loadUnpaidFollowupSettings,
	setUnpaidFollowupEnabled,
	unpaidFollowupEnabledKey,
} from "./settings";

const requestSchema = z.object({
	action: z.enum(["preview", "status", "enable", "disable"]).default("preview"),
	orderNumber: z.string().trim().min(4).max(80).optional(),
	/** Preview older expired orders too (default: only the live 30–60 min window). */
	lookbackMinutes: z.number().int().min(60).max(10_080).optional(),
	limit: z.number().int().min(1).max(50).default(20),
});

type Timing =
	| "still_payable"
	| "not_due"
	| "due"
	| "window_passed"
	| "before_activation"
	| "disabled";

function timing(
	order: { status: string; expiresAt: number; createdAt: number },
	settings: { enabled: boolean; activatedAt: number | null },
	now: number,
): Timing {
	if (order.status === "pending_payment" && order.expiresAt > now)
		return "still_payable";
	if (!settings.enabled || settings.activatedAt === null) return "disabled";
	if (order.createdAt < settings.activatedAt) return "before_activation";
	if (now < order.expiresAt + unpaidFollowupDelayMs) return "not_due";
	if (now > order.expiresAt + unpaidFollowupWindowEndMs) return "window_passed";
	return "due";
}

/**
 * Dry run: who would get the follow-up and the exact subject/body they would
 * receive. Only reads; never claims, enqueues or sends anything.
 */
export async function previewUnpaidFollowups(
	db: D1Database,
	input: { orderNumber?: string; lookbackMinutes?: number; limit?: number },
	now = Date.now(),
) {
	const settings = await loadUnpaidFollowupSettings(db);
	const sender = await approvedFollowupSender(db);
	const runtime = await loadRuntimeConfig(db);
	let ids: string[];
	if (input.orderNumber) {
		const order = await loadFollowupOrder(db, {
			orderNumber: input.orderNumber,
		});
		if (!order)
			throw new DomainError("order_not_found", 404, "Order not found");
		ids = [order.id];
	} else {
		const rows = await db
			.prepare(
				`SELECT o.id FROM shop_orders o INDEXED BY shop_orders_status_expires_idx
				 WHERE o.status = 'expired' AND o.expires_at > ? AND o.expires_at <= ?
				 ORDER BY o.expires_at DESC, o.id LIMIT ?`,
			)
			.bind(
				now - (input.lookbackMinutes ?? 60) * 60_000,
				input.lookbackMinutes ? now : now - unpaidFollowupDelayMs,
				input.limit ?? 20,
			)
			.all<{ id: string }>();
		ids = rows.results.map((row) => row.id);
	}
	const orders = [];
	for (const id of ids) {
		const order = await loadFollowupOrder(db, { id });
		if (!order) continue;
		const assessment = await assessUnpaidOrder(db, order, now);
		const when = timing(assessment, settings, now);
		const existing = await db
			.prepare(
				"SELECT status, status_reason, sent_at FROM unpaid_order_followups WHERE order_id = ?",
			)
			.bind(order.id)
			.first<{
				status: string;
				status_reason: string | null;
				sent_at: number | null;
			}>();
		const email = await renderFollowupFor(db, runtime, assessment);
		orders.push({
			orderNumber: assessment.orderNumber,
			email: assessment.email,
			locale: assessment.locale,
			orderStatus: assessment.status,
			createdAt: new Date(assessment.createdAt).toISOString(),
			expiresAt: new Date(assessment.expiresAt).toISOString(),
			item: assessment.item,
			usdtHint: assessment.usdtHint,
			eligibleByRules: assessment.eligible,
			reason: assessment.reason,
			timing: when,
			alreadyRecorded: existing
				? {
						status: existing.status,
						reason: existing.status_reason,
						sentAt: existing.sent_at
							? new Date(existing.sent_at).toISOString()
							: null,
					}
				: null,
			wouldSendNow:
				assessment.eligible &&
				when === "due" &&
				!existing &&
				Boolean(sender) &&
				Boolean(email),
			rendered: email ? { subject: email.subject, text: email.text } : null,
		});
	}
	return {
		dryRun: true as const,
		enabled: settings.enabled,
		activatedAt: settings.activatedAt
			? new Date(settings.activatedAt).toISOString()
			: null,
		senderReady: Boolean(sender),
		orders,
	};
}

export async function unpaidFollowupStatus(db: D1Database, now = Date.now()) {
	const settings = await loadUnpaidFollowupSettings(db);
	const sender = await approvedFollowupSender(db);
	const rows = await db
		.prepare(
			`SELECT status, COALESCE(status_reason, '') AS reason, COUNT(*) AS count,
			 SUM(usdt_hint) AS usdt_hint FROM unpaid_order_followups
			 WHERE created_at >= ? GROUP BY status, reason ORDER BY status, reason`,
		)
		.bind(now - 30 * 86_400_000)
		.all<{
			status: string;
			reason: string;
			count: number;
			usdt_hint: number;
		}>();
	return {
		settingKey: unpaidFollowupEnabledKey,
		enabled: settings.enabled,
		activatedAt: settings.activatedAt
			? new Date(settings.activatedAt).toISOString()
			: null,
		senderReady: Boolean(sender),
		last30Days: rows.results.map((row) => ({
			status: row.status,
			reason: row.reason || null,
			count: Number(row.count),
			usdtHint: Number(row.usdt_hint ?? 0),
		})),
	};
}

const opsJson = (body: unknown, status: number) =>
	Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** POST /api/ops/unpaid-followup, guarded by the existing ops bearer token. */
export async function handleUnpaidFollowupRequest(
	request: Request,
	env: Pick<CloudflareBindings, "DB" | "RESTOCK_API_TOKEN">,
	now = Date.now(),
): Promise<Response> {
	try {
		const db = env.DB;
		if (!db || !env.RESTOCK_API_TOKEN)
			throw new DomainError("ops_api_unavailable", 503, "Ops API unavailable");
		const header = request.headers.get("authorization") ?? "";
		const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
		if (!supplied || !constantTimeEqual(supplied, env.RESTOCK_API_TOKEN))
			throw new DomainError("ops_unauthorized", 401, "Invalid credentials");
		const budget = await claimFixedWindowRateLimit(db, {
			bucketKey: `unpaid-followup:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
			limit: 20,
			windowMs: 60_000,
		});
		if (!budget.allowed)
			throw new DomainError("ops_rate_limited", 429, "Rate limit exceeded");
		const text = await request.text();
		const input = requestSchema.parse(text.trim() ? JSON.parse(text) : {});
		if (input.action === "preview")
			return opsJson(
				{ ok: true, ...(await previewUnpaidFollowups(db, input, now)) },
				200,
			);
		if (input.action === "status")
			return opsJson(
				{ ok: true, ...(await unpaidFollowupStatus(db, now)) },
				200,
			);
		const enable = input.action === "enable";
		const before = await loadUnpaidFollowupSettings(db);
		// Re-enabling while already on keeps the original activation time.
		if (before.enabled !== enable)
			await setUnpaidFollowupEnabled(db, enable, now);
		const after = await loadUnpaidFollowupSettings(db);
		await db
			.prepare(
				`INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,request_id,ip_address,before,after,created_at) VALUES (?,NULL,'unpaid_followup.switch','system_settings',?,?,?,?,?,?)`,
			)
			.bind(
				crypto.randomUUID(),
				unpaidFollowupEnabledKey,
				request.headers.get("x-request-id"),
				request.headers.get("cf-connecting-ip"),
				JSON.stringify(before),
				JSON.stringify({ via: "ops", ...after }),
				now,
			)
			.run();
		return opsJson(
			{
				ok: true,
				settingKey: unpaidFollowupEnabledKey,
				enabled: after.enabled,
				activatedAt: after.activatedAt
					? new Date(after.activatedAt).toISOString()
					: null,
			},
			200,
		);
	} catch (error) {
		if (error instanceof DomainError)
			return opsJson({ ok: false, error: error.code }, error.status);
		if (error instanceof z.ZodError || error instanceof SyntaxError)
			return opsJson({ ok: false, error: "ops_invalid" }, 400);
		return opsJson({ ok: false, error: "unpaid_followup_failed" }, 500);
	}
}
