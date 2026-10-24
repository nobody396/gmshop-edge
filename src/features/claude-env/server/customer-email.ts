import {
	claudeEnvReadyEmailEvent,
	enqueueEmailNotification,
	supportReplyEmailSender,
} from "#/features/notifications/server/delivery";
import { loadRuntimeConfig } from "#/server/runtime-config";

const shopOrigin = "https://laoshirenvip.com";

/** Plain notice with no secrets: the activation code stays behind the logged-in order page. */
export function renderClaudeEnvReadyEmail(input: {
	orderUrl: string;
	expiresText: string;
}) {
	const subject = "你的 Claude 专属环境已开通";
	const lines = [
		"你好，",
		"你购买的「Claude 稳定使用环境」已开通，专属美国 IP 已经准备好。",
		`到期时间：${input.expiresText}（北京时间）`,
		`下一步：登录后打开订单页 → ${input.orderUrl}`,
		"在「Claude 专属环境」里点「显示开通码」，复制对应电脑的一行命令运行即可。",
		"如有问题，请在订单页点「联系客服」。",
		"老实人AI VIP",
	];
	const escapeHtml = (value: string) =>
		value
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;");
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
			`SELECT s.id, s.email, s.user_id, s.expires_at, o.order_number
			 FROM claude_env_subscriptions s JOIN shop_orders o ON o.id = s.order_id
			 WHERE s.id = ? AND s.status = 'active'`,
		)
		.bind(subscriptionId)
		.first<{
			id: string;
			email: string;
			user_id: string;
			expires_at: number | null;
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
