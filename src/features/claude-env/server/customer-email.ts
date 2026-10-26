import {
	claudeEnvExpiryEmailEvent,
	claudeEnvReadyEmailEvent,
	enqueueEmailNotification,
	supportReplyEmailSender,
} from "#/features/notifications/server/delivery";
import { recipientHash } from "#/features/notifications/server/recipient-policy";
import {
	renewalOrigin,
	renewalUnsubscribeUrl,
} from "#/features/renewals/server/links";
import type { SupportedLocale } from "#/lib/locales";
import { loadRuntimeConfig } from "#/server/runtime-config";
import {
	beijingMinute,
	displayCity,
	type ReminderPoint,
	renewalPath,
} from "../domain";

const shopOrigin = "https://laoshirenvip.com";
export const claudeEnvGuideSlug = "claude-env-setup";
const guideUrl = `${shopOrigin}/guides/${claudeEnvGuideSlug}`;

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

/** Plain notice with no secrets: the activation code stays behind the logged-in order page. */
export function renderClaudeEnvReadyEmail(input: {
	orderUrl: string;
	expiresText: string;
	email: string;
	ip: string | null;
	city: string | null;
}) {
	const subject = "你的 Claude 专属环境已开通";
	const lines = [
		"你好，",
		"你购买的「Claude 稳定使用环境」已开通，可以开始使用了。",
		`专属 IP：${input.ip ?? "—"}${input.city ? `（${input.city}）` : ""}`,
		`到期时间：${input.expiresText}（北京时间）`,
		`完整图文教程（配环境 → 注册 ProtonMail → 注册 Claude → 开通会员，一步一步来）：${guideUrl}`,
		"开始使用（大约 5 分钟）：",
		"① 打开代理软件 Clash Verge Rev，确认能正常打开 google.com。",
		`② 打开 ${shopOrigin} 点「登录」，用下单邮箱 ${input.email} 登录：Gmail 邮箱可以直接点「Google 登录」；没设过密码的，在登录页点「忘记密码」，用这个邮箱收验证码设一个密码。登录后点顶部「我的订单」，打开这一单 → ${input.orderUrl}`,
		"在「Claude 专属环境」里点「显示开通码」，复制对应电脑的那一行命令：Mac 粘贴到「终端」，Windows 粘贴到管理员身份的「终端」或「PowerShell」，回车运行。",
		"③ 过程中 Mac 会让你输入一次开机密码（Windows 点一次「是」），中间会让你手动关一下「定位服务」。最后出现「全部验收通过 ✅」就好了；没通过的，把窗口截图发给客服。",
		`④ 重启电脑一次，然后打开 ${shopOrigin}/ip-check ，确认显示的 IP 和上面的专属 IP 一样。`,
		"使用提醒：",
		"· 用 ProtonMail 邮箱注册 Claude；这套环境可以养 2～3 个号，换号时先退出登录再登另一个",
		"· 这些号不要在插着国内手机卡的安卓手机上登录，最好只在这台电脑上用",
		"· 号被限制时先停下来走官方申诉，不要换网络反复尝试",
		"· 不续费的话，到期后环境立即失效，专属 IP 会被释放，无法找回",
		"以后随时登录本站 →「我的订单」→ 打开这一单，在「Claude 专属环境」里能看到本月流量、到期时间和线路状态，也可以直接续费。",
		"开通码就是你的专属线路密码，请不要发给别人。如有问题，请在订单页点「联系客服」。",
		"老实人AI VIP",
	];
	const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#111827;font-size:15px;line-height:1.7"><div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">${lines
		.map(
			(line) =>
				`<p style="margin:0 0 12px">${escapeHtml(line).replace(
					/https:\/\/[^\s<]+/g,
					(url) => `<a href="${url}" style="color:#2563eb">${url}</a>`,
				)}</p>`,
		)
		.join("")}</div></body></html>`;
	return { subject, text: lines.join("\n\n"), html };
}

/**
 * Activation = delivery completion (an approved GMShop transactional event).
 * Only the approved Cloudflare sender is used; anything else is skipped.
 */
export async function enqueueClaudeEnvReadyEmail(
	db: D1Database,
	subscriptionId: string,
) {
	const row = await db
		.prepare(
			`SELECT s.id, s.email, s.user_id, s.expires_at, s.ip, s.ip_city, o.order_number
			 FROM claude_env_subscriptions s JOIN shop_orders o ON o.id = s.order_id
			 WHERE s.id = ? AND s.status = 'active'`,
		)
		.bind(subscriptionId)
		.first<{
			id: string;
			email: string;
			user_id: string;
			expires_at: number | null;
			ip: string | null;
			ip_city: string | null;
			order_number: string;
		}>();
	if (!row) return { status: "skipped" as const, reason: "not_active" };
	const config = await db
		.prepare(
			"SELECT id FROM notification_channel_configs WHERE enabled=1 AND channel='email' AND provider='cloudflare_email' AND from_address=? ORDER BY sort_order,id LIMIT 1",
		)
		.bind(supportReplyEmailSender)
		.first<{ id: string }>();
	if (!config)
		return { status: "skipped" as const, reason: "sender_unavailable" };
	const origin = (await loadRuntimeConfig(db)).betterAuthUrl || shopOrigin;
	const expiresText = row.expires_at
		? new Date(row.expires_at + 8 * 3_600_000)
				.toISOString()
				.slice(0, 16)
				.replace("T", " ")
		: "—";
	const content = renderClaudeEnvReadyEmail({
		orderUrl: new URL(
			`/account/orders/${encodeURIComponent(row.order_number)}`,
			origin,
		).toString(),
		expiresText,
		email: row.email,
		ip: row.ip,
		city: displayCity(row.ip_city),
	});
	const delivery = await enqueueEmailNotification(db, {
		event: claudeEnvReadyEmailEvent,
		idempotencyKey: `claude-env-ready:${row.id}`,
		configId: config.id,
		locale: "zh-CN",
		message: {
			to: row.email,
			from: supportReplyEmailSender,
			replyTo: "",
			...content,
		},
	});
	return { status: "queued" as const, deliveryId: delivery.id };
}

// ---------- expiry reminders (7 / 5 / 3 days before expiry) ----------

const expiryCopy = {
	"zh-CN": {
		subject: (n: number) =>
			`【老实人AI VIP】你的 Claude 专属环境还有 ${n} 天到期`,
		greeting: "你好，",
		intro: (n: number, plan: string) =>
			`你购买的「Claude 稳定使用环境」（${plan}）还有 ${n} 天到期。`,
		expires: (at: string) => `到期时间：${at} 北京时间`,
		keep: "续费后专属 IP 不变，不用重新配置。",
		warning:
			"如果不续费，到期后环境会立即失效，专属 IP 会被释放，再也无法找回。",
		renew: "立即续费",
		renewLine: (url: string) => `立即续费：${url}`,
		support: "如有问题，请在订单页点「联系客服」。",
		unsubscribe: (url: string) => `不想再收到到期提醒：${url}`,
		unsubscribeLabel: "不想再收到到期提醒",
		monthly: "月付",
		quarterly: "季付",
	},
	"en-US": {
		subject: (n: number) =>
			`[老实人AI VIP] Your dedicated Claude environment expires in ${n} day${n === 1 ? "" : "s"}`,
		greeting: "Hello,",
		intro: (n: number, plan: string) =>
			`Your "Claude stable environment" (${plan}) expires in ${n} day${n === 1 ? "" : "s"}.`,
		expires: (at: string) => `Expires: ${at} Beijing time (UTC+8)`,
		keep: "After renewal your dedicated IP stays the same; no need to set anything up again.",
		warning:
			"If you do not renew, the environment stops working the moment it expires and the dedicated IP is released. It can never be recovered.",
		renew: "Renew now",
		renewLine: (url: string) => `Renew now: ${url}`,
		support: 'Questions? Open your order page and click "Contact support".',
		unsubscribe: (url: string) => `Stop expiry reminders: ${url}`,
		unsubscribeLabel: "Stop expiry reminders",
		monthly: "monthly",
		quarterly: "quarterly",
	},
} as const;

/**
 * Entitlement-expiry reminder (an approved GMShop transactional event). No
 * activation code, no coupon, no upstream details.
 */
export function renderClaudeEnvExpiryEmail(input: {
	locale: SupportedLocale;
	daysLeft: number;
	expiresAt: number;
	plan: string;
	renewUrl: string;
	unsubscribeUrl: string | null;
}) {
	const c = expiryCopy[input.locale];
	const plan = input.plan.endsWith("quarterly") ? c.quarterly : c.monthly;
	const expires = c.expires(beijingMinute(input.expiresAt));
	const subject = c.subject(input.daysLeft);
	const text = [
		c.greeting,
		c.intro(input.daysLeft, plan),
		expires,
		c.renewLine(input.renewUrl),
		c.keep,
		c.warning,
		c.support,
		"老实人AI VIP",
		...(input.unsubscribeUrl ? [c.unsubscribe(input.unsubscribeUrl)] : []),
	].join("\n\n");
	const p = (inner: string, style = "") =>
		`<p style="margin:0 0 12px${style}">${inner}</p>`;
	const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color:#111827;font-size:15px;line-height:1.7"><div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">${[
		p(escapeHtml(c.greeting)),
		p(escapeHtml(c.intro(input.daysLeft, plan))),
		p(`<strong>${escapeHtml(expires)}</strong>`),
		`<p style="margin:20px 0"><a href="${escapeHtml(input.renewUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px">${escapeHtml(c.renew)}</a></p>`,
		p(escapeHtml(c.keep)),
		p(
			`<strong>${escapeHtml(c.warning)}</strong>`,
			";padding:12px;border-radius:8px;background:#fef2f2;color:#b91c1c",
		),
		p(escapeHtml(c.support)),
		p("老实人AI VIP"),
		input.unsubscribeUrl
			? p(
					`<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#6b7280">${escapeHtml(c.unsubscribeLabel)}</a>`,
					";font-size:12px;color:#6b7280",
				)
			: "",
	].join("")}</div></body></html>`;
	return { subject, text, html };
}

export type ExpiryEmailInput = {
	subscriptionId: string;
	userId: string;
	to: string;
	recipientKind: "account" | "order";
	point: ReminderPoint;
	daysLeft: number;
	expiresAt: number;
	plan: string;
	locale: SupportedLocale;
};

export type ExpiryEmailResult = {
	status: "queued" | "skipped" | "unsubscribed" | "suppressed";
	reason?: string;
	deliveryId?: string;
};

export type SendExpiryEmail = (
	db: D1Database,
	input: ExpiryEmailInput,
) => Promise<ExpiryEmailResult>;

/**
 * Only through the approved Cloudflare sender; skipped (and recorded by the
 * caller) when it is not configured. Respects the renewal-reminder opt-out,
 * the account's entitlement-expiry email preference and hard-bounce suppression.
 */
export const enqueueClaudeEnvExpiryEmail: SendExpiryEmail = async (
	db,
	input,
) => {
	const config = await db
		.prepare(
			"SELECT id FROM notification_channel_configs WHERE enabled=1 AND channel='email' AND provider='cloudflare_email' AND from_address=? ORDER BY sort_order,id LIMIT 1",
		)
		.bind(supportReplyEmailSender)
		.first<{ id: string }>();
	if (!config) return { status: "skipped", reason: "sender_unavailable" };
	const hash = await recipientHash(input.to);
	const unsubscribed = await db
		.prepare(
			"SELECT 1 AS found FROM email_unsubscribes WHERE recipient_hash = ? AND scope = 'renewal' LIMIT 1",
		)
		.bind(hash)
		.first<{ found: number }>();
	if (unsubscribed) return { status: "unsubscribed", reason: "unsubscribed" };
	const preference = await db
		.prepare(
			`SELECT enabled FROM notification_subscriptions WHERE user_id = ?
			 AND event = 'entitlement_expiring' AND channel = 'email' LIMIT 1`,
		)
		.bind(input.userId)
		.first<{ enabled: number }>();
	if (preference?.enabled === 0)
		return { status: "unsubscribed", reason: "preference" };
	const runtime = await loadRuntimeConfig(db);
	const origin = runtime.betterAuthUrl ? renewalOrigin(runtime) : shopOrigin;
	let unsubscribeUrl: string | null = null;
	let oneClick: string | null = null;
	try {
		unsubscribeUrl = await renewalUnsubscribeUrl(runtime, input.to);
		oneClick = await renewalUnsubscribeUrl(
			runtime,
			input.to,
			"/api/shop/renewal/unsubscribe",
		);
	} catch {
		unsubscribeUrl = null;
	}
	const content = renderClaudeEnvExpiryEmail({
		locale: input.locale,
		daysLeft: input.daysLeft,
		expiresAt: input.expiresAt,
		plan: input.plan,
		renewUrl: new URL(renewalPath(input.plan), origin).toString(),
		unsubscribeUrl,
	});
	const delivery = await enqueueEmailNotification(db, {
		event: claudeEnvExpiryEmailEvent,
		idempotencyKey: `claude-env-expiry:${input.subscriptionId}:${input.expiresAt}:${input.point}:${hash.slice(0, 24)}`,
		configId: config.id,
		locale: input.locale,
		message: {
			to: input.to,
			from: supportReplyEmailSender,
			replyTo: "",
			...content,
			...(oneClick
				? {
						headers: {
							"List-Unsubscribe": `<${oneClick}>`,
							"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
						},
					}
				: {}),
		},
	});
	return delivery.status === "suppressed"
		? { status: "suppressed", deliveryId: delivery.id }
		: { status: "queued", deliveryId: delivery.id };
};
