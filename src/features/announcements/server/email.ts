import { z } from "zod";
import { ownLinkTags, tagOwnLinks } from "#/features/attribution/utm";
import {
	announcementEmailEvent,
	enqueueEmailNotification,
	supportReplyEmailSender,
} from "#/features/notifications/server/delivery";
import {
	isReservedEmailRecipient,
	recipientHash,
} from "#/features/notifications/server/recipient-policy";
import {
	renewalOrigin,
	renewalUnsubscribeUrl,
} from "#/features/renewals/server/links";
import { constantTimeEqual } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { loadRuntimeConfig } from "#/server/runtime-config";

/**
 * One-off product announcement to past paying customers, sent only through the
 * approved Cloudflare sender. Operator-triggered (bearer ops token), batched,
 * idempotent per campaign + recipient, and never sent to agents, staff,
 * reseller downstream buyers, unsubscribed or suppressed addresses.
 */
export const unsubscribePlaceholder = "{{unsubscribe_url}}";
export const announcementMaxBatch = 50;

const segment = z.enum(["claude", "all"]);
const campaignKey = z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/);
export const announcementSchema = z
	.object({
		campaignKey,
		segment,
		excludeSegment: segment.nullish(),
		excludeCampaignKeys: z.array(campaignKey).max(10).default([]),
		excludeEmails: z.array(z.email().max(320)).max(1000).default([]),
		subject: z.string().trim().min(1).max(200),
		text: z.string().min(1).max(50_000),
		html: z.string().min(1).max(150_000),
		dryRun: z.boolean().default(true),
		limit: z.number().int().min(1).max(announcementMaxBatch).default(25),
	})
	.refine(
		(value) =>
			value.text.includes(unsubscribePlaceholder) &&
			value.html.includes(unsubscribePlaceholder),
		{ message: "unsubscribe_placeholder_required" },
	);
export type AnnouncementInput = z.input<typeof announcementSchema>;

export function announcementKey(campaign: string, hash: string) {
	return `announcement:${campaign}:${hash.slice(0, 32)}`;
}

/** Paid, not refunded, not placed through the supplier API (agents' customers). */
const paidOrderCondition = `o.paid_at IS NOT NULL AND o.refunded_at IS NULL
 AND o.status NOT IN ('refunding','refunded')
 AND NOT EXISTS (SELECT 1 FROM refunds rf WHERE rf.order_id = o.id AND rf.status = 'succeeded')
 AND NOT EXISTS (SELECT 1 FROM supplier_api_orders sa WHERE sa.shop_order_id = o.id)
 AND o.normalized_contact_email IS NOT NULL AND o.normalized_contact_email <> ''`;
const claudeOrderCondition = `EXISTS (SELECT 1 FROM shop_order_items i WHERE i.order_id = o.id
 AND (i.product_name LIKE '%Claude%' OR i.sellable_item_name LIKE '%Claude%'))`;

async function segmentEmails(db: D1Database, name: z.infer<typeof segment>) {
	const rows = await db
		.prepare(
			`SELECT DISTINCT lower(trim(o.normalized_contact_email)) AS email FROM shop_orders o
			 WHERE ${paidOrderCondition}${name === "claude" ? ` AND ${claudeOrderCondition}` : ""}
			 ORDER BY email`,
		)
		.all<{ email: string }>();
	return rows.results.map((row) => row.email);
}

async function emailSet(db: D1Database, sql: string, ...binds: unknown[]) {
	const rows = await db
		.prepare(sql)
		.bind(...binds)
		.all<{ value: string }>();
	return new Set(rows.results.map((row) => row.value));
}

export type AnnouncementPlan = {
	candidates: number;
	eligible: string[];
	excluded: Record<string, number>;
	alreadySent: number;
};

export async function planAnnouncement(
	db: D1Database,
	input: z.output<typeof announcementSchema>,
): Promise<AnnouncementPlan> {
	const candidates = await segmentEmails(db, input.segment);
	const excludedSegment = input.excludeSegment
		? new Set(await segmentEmails(db, input.excludeSegment))
		: new Set<string>();
	// Staff: any role other than customer/guest (same rule as renewal reminders).
	const staff = await emailSet(
		db,
		`SELECT DISTINCT lower(su.email) AS value FROM users su, json_each(su.role_ids) assigned
		 JOIN roles sr ON sr.id = assigned.value WHERE sr.name NOT IN ('customer','guest')`,
	);
	// Agents: anyone who bought a sub-site / API access.
	const agents = await emailSet(
		db,
		"SELECT DISTINCT lower(trim(email)) AS value FROM agent_access_orders WHERE email IS NOT NULL",
	);
	const unsubscribed = await emailSet(
		db,
		"SELECT DISTINCT recipient_hash AS value FROM email_unsubscribes",
	);
	const suppressed = await emailSet(
		db,
		"SELECT DISTINCT recipient_hash AS value FROM email_recipient_suppressions",
	);
	const sentKeys = await emailSet(
		db,
		"SELECT idempotency_key AS value FROM notification_deliveries WHERE event = ? AND idempotency_key LIKE 'announcement:%'",
		announcementEmailEvent,
	);
	const operator = new Set(
		input.excludeEmails.map((email) => email.trim().toLowerCase()),
	);
	const excluded: Record<string, number> = {
		exclude_segment: 0,
		exclude_campaign: 0,
		operator_list: 0,
		staff: 0,
		agent: 0,
		unsubscribed: 0,
		suppressed: 0,
		reserved: 0,
	};
	const eligible: string[] = [];
	let alreadySent = 0;
	for (const email of candidates) {
		const hash = await recipientHash(email);
		const reason = excludedSegment.has(email)
			? "exclude_segment"
			: input.excludeCampaignKeys.some((key) =>
						sentKeys.has(announcementKey(key, hash)),
					)
				? "exclude_campaign"
				: operator.has(email)
					? "operator_list"
					: staff.has(email)
						? "staff"
						: agents.has(email)
							? "agent"
							: unsubscribed.has(hash)
								? "unsubscribed"
								: suppressed.has(hash)
									? "suppressed"
									: isReservedEmailRecipient(email)
										? "reserved"
										: null;
		if (reason) {
			excluded[reason] = (excluded[reason] ?? 0) + 1;
			continue;
		}
		if (sentKeys.has(announcementKey(input.campaignKey, hash))) {
			alreadySent += 1;
			continue;
		}
		eligible.push(email);
	}
	return { candidates: candidates.length, eligible, excluded, alreadySent };
}

function escapeHtmlAttribute(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export async function runAnnouncement(db: D1Database, raw: AnnouncementInput) {
	const input = announcementSchema.parse(raw);
	const plan = await planAnnouncement(db, input);
	const summary = {
		campaignKey: input.campaignKey,
		segment: input.segment,
		candidates: plan.candidates,
		excluded: plan.excluded,
		alreadySent: plan.alreadySent,
		eligible: plan.eligible.length,
	};
	if (input.dryRun) return { dryRun: true as const, ...summary };
	const config = await db
		.prepare(
			"SELECT id FROM notification_channel_configs WHERE enabled=1 AND channel='email' AND provider='cloudflare_email' AND from_address=? ORDER BY sort_order,id LIMIT 1",
		)
		.bind(supportReplyEmailSender)
		.first<{ id: string }>();
	if (!config)
		throw new DomainError(
			"announcement_sender_unavailable",
			503,
			"Approved sender unavailable",
		);
	const runtime = await loadRuntimeConfig(db);
	// Tag links to our own site before the per-recipient unsubscribe link goes in.
	const origin = renewalOrigin(runtime);
	const tag = ownLinkTags.announcement(input.campaignKey);
	const text = tagOwnLinks(input.text, origin, tag);
	const html = tagOwnLinks(input.html, origin, tag, "html");
	let accepted = 0;
	let skipped = 0;
	let failed = 0;
	for (const email of plan.eligible.slice(0, input.limit)) {
		const hash = await recipientHash(email);
		const idempotencyKey = announcementKey(input.campaignKey, hash);
		try {
			const unsubscribeUrl = await renewalUnsubscribeUrl(runtime, email);
			const oneClick = await renewalUnsubscribeUrl(
				runtime,
				email,
				"/api/shop/renewal/unsubscribe",
			);
			const delivery = await enqueueEmailNotification(db, {
				event: announcementEmailEvent,
				idempotencyKey,
				configId: config.id,
				locale: "zh-CN",
				message: {
					to: email,
					from: supportReplyEmailSender,
					replyTo: "",
					subject: input.subject,
					text: text.replaceAll(unsubscribePlaceholder, unsubscribeUrl),
					html: html.replaceAll(
						unsubscribePlaceholder,
						escapeHtmlAttribute(unsubscribeUrl),
					),
					headers: {
						"List-Unsubscribe": `<${oneClick}>`,
						"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
					},
				},
			});
			if (delivery.duplicate || delivery.status === "suppressed") skipped += 1;
			else accepted += 1;
		} catch {
			const existing = await db
				.prepare(
					"SELECT id FROM notification_deliveries WHERE idempotency_key=?",
				)
				.bind(idempotencyKey)
				.first<{ id: string }>();
			if (existing) skipped += 1;
			else failed += 1;
		}
	}
	return {
		dryRun: false as const,
		...summary,
		accepted,
		skipped,
		failed,
		remaining: Math.max(0, plan.eligible.length - accepted - skipped - failed),
	};
}

const opsJson = (body: unknown, status: number) =>
	Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** POST /api/ops/announcement-email, guarded by the existing ops bearer token. */
export async function handleAnnouncementEmailRequest(
	request: Request,
	env: Pick<CloudflareBindings, "DB" | "RESTOCK_API_TOKEN">,
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
			bucketKey: `announcement-email:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
			limit: 20,
			windowMs: 60_000,
		});
		if (!budget.allowed)
			throw new DomainError("ops_rate_limited", 429, "Rate limit exceeded");
		const result = await runAnnouncement(db, await request.json());
		if (!result.dryRun)
			await db
				.prepare(
					`INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,request_id,ip_address,before,after,created_at) VALUES (?,NULL,'announcement.email_batch','announcement',?,?,?,NULL,?,?)`,
				)
				.bind(
					crypto.randomUUID(),
					result.campaignKey,
					request.headers.get("x-request-id"),
					request.headers.get("cf-connecting-ip"),
					JSON.stringify({
						via: "ops",
						segment: result.segment,
						accepted: result.accepted,
						skipped: result.skipped,
						failed: result.failed,
					}),
					Date.now(),
				)
				.run();
		return opsJson({ ok: true, ...result }, 200);
	} catch (error) {
		if (error instanceof DomainError)
			return opsJson({ ok: false, error: error.code }, error.status);
		if (error instanceof z.ZodError || error instanceof SyntaxError)
			return opsJson({ ok: false, error: "ops_invalid" }, 400);
		return opsJson({ ok: false, error: "announcement_email_failed" }, 500);
	}
}
