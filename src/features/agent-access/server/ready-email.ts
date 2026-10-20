import { z } from "zod";
import {
	agentAccessReadyEmailEvent,
	enqueueEmailNotification,
	supportReplyEmailSender,
} from "#/features/notifications/server/delivery";
import { constantTimeEqual } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
import type { SupportedLocale } from "#/lib/locales";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { loadRuntimeConfig } from "#/server/runtime-config";
import type { AgentAccessKind } from "../products";
import { type AgentTransport, agentOrigin, callAgent } from "./client";

// lsrai.shop pricing defaults (reseller.program.default/min_markup_percent).
const defaultMarkupPercent = 5;
const minMarkupPercent = 3;
const shopOrigin = "https://laoshirenvip.com";

type ReadyRow = {
	order_item_id: string;
	user_id: string;
	kind: AgentAccessKind;
	email: string;
	state: string;
	domain: string | null;
	requested_subdomain: string | null;
	subdomain_fallback: string | null;
	order_number: string;
	order_locale: string | null;
};
const readyQuery = `SELECT a.order_item_id,a.user_id,a.kind,a.email,a.state,a.domain,a.requested_subdomain,a.subdomain_fallback,
 o.order_number,o.locale AS order_locale
 FROM agent_access_orders a JOIN shop_order_items oi ON oi.id=a.order_item_id JOIN shop_orders o ON o.id=oi.order_id`;

export type ReadyEmailContent = {
	kind: AgentAccessKind;
	locale: SupportedLocale;
	domain: string | null;
	email: string;
	orderUrl: string;
	requestedSubdomain?: string | null;
	subdomainFallback?: string | null;
};

/** One address per (order item, domain): a changed sub-site host earns one new email. */
export function agentAccessReadyKey(
	orderItemId: string,
	domain: string | null,
) {
	return `agent-access-ready:${orderItemId}:${domain ?? "api"}`;
}

function fallbackNote(input: ReadyEmailContent) {
	const requested = input.requestedSubdomain;
	if (!input.subdomainFallback || !requested || !input.domain) return null;
	// The owner may later move the site onto the requested name.
	if (input.domain.startsWith(`${requested}.`)) return null;
	const zh = input.locale === "zh-CN";
	if (input.subdomainFallback === "existing")
		return zh
			? "你已有子站，继续沿用原店铺地址。"
			: "You already had a sub-site, so its existing address is kept.";
	if (input.subdomainFallback === "taken")
		return zh
			? `你选的名字「${requested}」已被占用，已自动分配：${input.domain}`
			: `The name "${requested}" was already taken, so we assigned: ${input.domain}`;
	return zh
		? `你选的名字「${requested}」不可用，已自动分配：${input.domain}`
		: `The name "${requested}" is unavailable, so we assigned: ${input.domain}`;
}

type Block =
	| { type: "p"; lines: string[] }
	| { type: "ol"; title: string; items: string[] };

function blocks(input: ReadyEmailContent): {
	subject: string;
	body: Block[];
} {
	const zh = input.locale === "zh-CN";
	const store = input.domain ? `https://${input.domain}` : "";
	const login = zh
		? [
				`后台登录：${agentOrigin}`,
				`登录账号：${input.email}`,
				`初始密码：在订单页查看 → ${input.orderUrl}（首次登录后请改成自己的密码；已有账号沿用原密码）`,
			]
		: [
				`Dashboard login: ${agentOrigin}`,
				`Login email: ${input.email}`,
				`Initial password: see your order page → ${input.orderUrl} (change it after first sign-in; existing accounts keep their current password)`,
			];
	const contact: Block = {
		type: "p",
		lines: [
			zh
				? "如有问题，请在订单页点「联系客服」"
				: "Questions? Use Contact support on your order page.",
		],
	};
	const signature: Block = { type: "p", lines: ["老实人AI VIP"] };
	const greeting: Block = { type: "p", lines: [zh ? "你好，" : "Hello,"] };
	if (input.kind === "subsite") {
		const note = fallbackNote(input);
		return {
			subject: zh
				? `子站代理已开通｜你的店铺：${store}`
				: `Your sub-site is ready | Your store: ${store}`,
			body: [
				greeting,
				{
					type: "p",
					lines: [
						zh
							? "你购买的「子站代理」已开通成功 🎉"
							: "Your Sub-site Partner access is now active 🎉",
					],
				},
				{
					type: "p",
					lines: [
						zh ? `你的店铺地址：${store}` : `Your store address: ${store}`,
						...(note ? [note] : []),
						zh
							? "把这个链接发给你的客户，他们就能直接在你的店里下单。"
							: "Share this link with your customers so they can order directly from your store.",
					],
				},
				{ type: "p", lines: login },
				{
					type: "ol",
					title: zh ? "接下来三步：" : "Next three steps:",
					items: zh
						? [
								"登录后台，先改密码",
								`进入「分销中心」查看店铺商品，核对售价（默认在供货价上加 ${defaultMarkupPercent}%，可以自己调，最低不少于 ${minMarkupPercent}%）`,
								"把店铺链接分享出去，订单、收益和提现都在后台看",
							]
						: [
								"Sign in and change your password first",
								`Open "Reseller Center" to review your store's products and prices (the default is supply price + ${defaultMarkupPercent}%; you can adjust it, but not below ${minMarkupPercent}%)`,
								"Share your store link; orders, earnings and withdrawals are all in the dashboard",
							],
				},
				{
					type: "p",
					lines: [
						zh
							? "子站已赠送 API 对接：在「个人中心 → API 对接」领取 Key，对接文档也在这一页。"
							: 'API integration is included with your sub-site: get your Key under "Personal Center → API Integration"; the documentation is on the same page.',
					],
				},
				contact,
				signature,
			],
		};
	}
	return {
		subject: zh ? "API 对接已开通" : "Your API integration is ready",
		body: [
			greeting,
			{
				type: "p",
				lines: [
					zh
						? "你购买的「API 对接」已开通成功 🎉"
						: "Your API Integration access is now active 🎉",
				],
			},
			{ type: "p", lines: login },
			{
				type: "ol",
				title: zh ? "接下来：" : "Next steps:",
				items: zh
					? [
							"登录后台 → 「个人中心 → API 对接」领取 Key 和 Secret（Secret 只显示一次）",
							"按同页文档对接",
							"先用 ¥0.01 测试商品和测试卡密跑通",
							"正式卖货前预存余额",
						]
					: [
							'Sign in → "Personal Center → API Integration" to get your Key and Secret (the Secret is shown only once)',
							"Integrate following the documentation on the same page",
							"Run an end-to-end test with the ¥0.01 test product and test card codes first",
							"Top up your balance before selling for real",
						],
			},
			contact,
			signature,
		],
	};
}

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
// Every URL is a real link in a monospace face: buyers misread "lsrai" (l vs I).
const linkify = (value: string) =>
	escapeHtml(value).replace(
		/https:\/\/[^\s（(<]+/g,
		(url) =>
			`<a href="${url}" style="color:#2563eb;font-family:Menlo,Consolas,monospace">${url}</a>`,
	);

export function renderAgentAccessReadyEmail(input: ReadyEmailContent) {
	const { subject, body } = blocks(input);
	const text = body
		.map((block) => {
			if (block.type === "p") return block.lines.join("\n");
			return [
				block.title,
				...block.items.map((item, i) => `${i + 1}. ${item}`),
			].join("\n");
		})
		.join("\n\n");
	const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#111827;font-size:15px;line-height:1.7"><div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">${body
		.map((block) => {
			if (block.type === "p")
				return `<p style="margin:0 0 16px">${block.lines.map(linkify).join("<br>")}</p>`;
			return `<p style="margin:0 0 4px">${escapeHtml(block.title)}</p><ol style="margin:0 0 16px;padding-left:20px">${block.items.map((item) => `<li>${linkify(item)}</li>`).join("")}</ol>`;
		})
		.join("")}</div></body></html>`;
	return { subject, text, html };
}

// users.preferred_locale is NOT NULL DEFAULT 'en-US', so it cannot tell an
// untouched default from a real choice. The checkout records the language the
// buyer actually shopped in; anything but en-US gets Chinese.
function emailLocale(row: ReadyRow): SupportedLocale {
	return row.order_locale === "en-US" ? "en-US" : "zh-CN";
}

export type ReadyEmailResult =
	| { status: "queued" | "duplicate" | "suppressed"; deliveryId: string }
	| {
			status: "skipped";
			reason:
				| "not_active"
				| "domain_missing"
				| "sender_unavailable"
				| "opted_out";
	  };

/**
 * Enqueue the activation-ready email for an active access order. Only the
 * approved Cloudflare sender is used; the idempotency key includes the domain.
 */
export async function enqueueAgentAccessReadyEmail(
	db: D1Database,
	orderItemId: string,
	options: { respectOptOut?: boolean } = {},
): Promise<ReadyEmailResult> {
	const row = await db
		.prepare(`${readyQuery} WHERE a.order_item_id=? LIMIT 1`)
		.bind(orderItemId)
		.first<ReadyRow>();
	if (!row || row.state !== "active")
		return { status: "skipped", reason: "not_active" };
	if (row.kind === "subsite" && !row.domain)
		return { status: "skipped", reason: "domain_missing" };
	if (options.respectOptOut) {
		const preference = await db
			.prepare(
				"SELECT enabled FROM notification_subscriptions WHERE user_id=? AND event='delivery_ready' AND channel='email' LIMIT 1",
			)
			.bind(row.user_id)
			.first<{ enabled: number }>();
		if (preference?.enabled === 0)
			return { status: "skipped", reason: "opted_out" };
	}
	const config = await db
		.prepare(
			"SELECT id FROM notification_channel_configs WHERE enabled=1 AND channel='email' AND provider='cloudflare_email' AND from_address=? ORDER BY sort_order,id LIMIT 1",
		)
		.bind(supportReplyEmailSender)
		.first<{ id: string }>();
	if (!config) return { status: "skipped", reason: "sender_unavailable" };
	const origin = (await loadRuntimeConfig(db)).betterAuthUrl || shopOrigin;
	const locale = emailLocale(row);
	const domain = row.kind === "subsite" ? row.domain : null;
	const content = renderAgentAccessReadyEmail({
		kind: row.kind,
		locale,
		domain,
		email: row.email,
		orderUrl: new URL(
			`/account/orders/${encodeURIComponent(row.order_number)}`,
			origin,
		).toString(),
		requestedSubdomain: row.requested_subdomain,
		subdomainFallback: row.subdomain_fallback,
	});
	const idempotencyKey = agentAccessReadyKey(row.order_item_id, domain);
	try {
		const delivery = await enqueueEmailNotification(db, {
			event: agentAccessReadyEmailEvent,
			idempotencyKey,
			configId: config.id,
			locale,
			message: {
				to: row.email,
				from: supportReplyEmailSender,
				replyTo: "",
				...content,
			},
		});
		return {
			status: delivery.duplicate
				? "duplicate"
				: delivery.status === "suppressed"
					? "suppressed"
					: "queued",
			deliveryId: delivery.id,
		};
	} catch (error) {
		// A concurrent enqueue may win the unique idempotency key.
		const existing = await db
			.prepare("SELECT id FROM notification_deliveries WHERE idempotency_key=?")
			.bind(idempotencyKey)
			.first<{ id: string }>();
		if (!existing) throw error;
		return { status: "duplicate", deliveryId: existing.id };
	}
}

/**
 * Operator path after a sub-site host changed on lsrai.shop: refresh the stored
 * domain from the signed `status` call, then send the ready email once for it.
 */
export async function refreshAgentAccessReadyEmail(
	db: D1Database,
	orderNumber: string,
	transport: AgentTransport = callAgent,
) {
	const row = await db
		.prepare(`${readyQuery} WHERE o.order_number=? LIMIT 1`)
		.bind(orderNumber)
		.first<ReadyRow>();
	if (!row) throw new DomainError("order_not_found", 404, "Order not found");
	if (row.state !== "active")
		throw new DomainError(
			"agent_access_not_active",
			409,
			"Access is not active",
		);
	const remote = await transport({
		operation: "status",
		sourceUserId: row.user_id,
		email: row.email,
		kind: row.kind,
		orderItemId: row.order_item_id,
	});
	const previousDomain = row.domain;
	const domain =
		row.kind === "subsite" ? (remote.domain ?? row.domain) : row.domain;
	if (domain !== previousDomain)
		await db
			.prepare(
				"UPDATE agent_access_orders SET domain=?,updated_at=? WHERE order_item_id=? AND state='active'",
			)
			.bind(domain, Date.now(), row.order_item_id)
			.run();
	// A just-renamed host is still warming up HTTPS; send once it serves.
	const email: ReadyEmailResult | { status: "waiting"; remoteState: string } =
		remote.state === "active"
			? await enqueueAgentAccessReadyEmail(db, row.order_item_id)
			: { status: "waiting", remoteState: remote.state };
	return {
		orderNumber: row.order_number,
		orderItemId: row.order_item_id,
		kind: row.kind,
		previousDomain,
		domain,
		email,
	};
}

const opsSchema = z.object({
	orderNumber: z
		.string()
		.trim()
		.regex(/^GM[A-F0-9]{32}$/),
});
const opsJson = (body: unknown, status: number) =>
	Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Ops entry for the same resend, guarded by the existing restock bearer token. */
export async function handleAgentAccessReadyEmailRequest(
	request: Request,
	env: Pick<CloudflareBindings, "DB" | "RESTOCK_API_TOKEN">,
	transport: AgentTransport = callAgent,
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
			bucketKey: `agent-ready-email:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
			limit: 10,
			windowMs: 60_000,
		});
		if (!budget.allowed)
			throw new DomainError("ops_rate_limited", 429, "Rate limit exceeded");
		const data = opsSchema.parse(await request.json());
		const result = await refreshAgentAccessReadyEmail(
			db,
			data.orderNumber,
			transport,
		);
		await db
			.prepare(
				`INSERT INTO audit_logs (id,actor_user_id,action,target_type,target_id,request_id,ip_address,before,after,created_at) VALUES (?,NULL,'agent_access.ready_email_resend','order_item',?,?,?,?,?,?)`,
			)
			.bind(
				crypto.randomUUID(),
				result.orderItemId,
				request.headers.get("x-request-id"),
				request.headers.get("cf-connecting-ip"),
				JSON.stringify({ domain: result.previousDomain }),
				JSON.stringify({
					via: "ops",
					domain: result.domain,
					email: result.email,
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
		return opsJson({ ok: false, error: "agent_ready_email_failed" }, 500);
	}
}
