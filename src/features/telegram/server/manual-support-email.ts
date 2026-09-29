import type { Api } from "grammy";
import {
	enqueueEmailNotification,
	supportReplyEmailEvent,
	supportReplyEmailSender,
} from "#/features/notifications/server/delivery";
import { DomainError } from "#/lib/domain-error";
import type { SupportedLocale } from "#/lib/locales";
import { decryptSecret } from "#/lib/secrets";
import { m } from "#/paraglide/messages";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import { supportFileRetentionMs } from "../web-support-attachments";
import { authorizeSupportAdministrator } from "./support-admins";
import { telegramRuntime } from "./sync";

type TopicInput = {
	chatId: string;
	threadId: number;
	userId: string;
	conversationId?: string;
};
export function supportEmailKeyboard(
	conversationId: string,
	locale: SupportedLocale = "zh-CN",
) {
	return {
		inline_keyboard: [
			[
				{
					text: m.telegram_web_support_email_button({}, { locale }),
					callback_data: `webmail:${conversationId}`,
				},
			],
		],
	};
}

export async function authorizeSupportEmailTopic(
	db: D1Database,
	api: Pick<Api, "getChatMember">,
	input: TopicInput,
) {
	const { settings } = await telegramRuntime(db);
	if (
		settings.supportChatId !== input.chatId ||
		!(await authorizeSupportAdministrator(db, api, {
			supportChatId: input.chatId,
			telegramUserId: input.userId,
			lastAdminSyncAt: settings.lastAdminSyncAt,
		}))
	)
		throw new DomainError("forbidden", 403, "Support administrator required");
	const conversation = await db
		.prepare(
			`SELECT c.id,c.email_encrypted,u.preferred_locale FROM telegram_web_support_conversations c LEFT JOIN users u ON u.id=c.user_id WHERE c.support_chat_id=? AND c.message_thread_id=? LIMIT 1`,
		)
		.bind(input.chatId, input.threadId)
		.first<{
			id: string;
			email_encrypted: string;
			preferred_locale: string | null;
		}>();
	if (
		!conversation ||
		(input.conversationId && conversation.id !== input.conversationId)
	)
		throw new DomainError(
			"support_topic_unavailable",
			404,
			"Support topic unavailable",
		);
	return conversation;
}

/** Only called from the administrator's explicit Telegram button callback. */
export async function requestManualSupportEmail(
	db: D1Database,
	api: Pick<Api, "getChatMember">,
	input: TopicInput,
) {
	const conversation = await authorizeSupportEmailTopic(db, api, input);
	const rate = await claimFixedWindowRateLimit(db, {
		bucketKey: `support:manual-email:${input.userId}`,
		limit: 10,
		windowMs: 60_000,
	});
	if (!rate.allowed)
		throw new DomainError("rate_limited", 429, "Too many requests");
	const reply = await db
		.prepare(
			"SELECT sequence FROM telegram_web_support_replies WHERE conversation_id=? AND expires_at>? AND created_at>? ORDER BY sequence DESC LIMIT 1",
		)
		.bind(conversation.id, Date.now(), Date.now() - supportFileRetentionMs)
		.first<{ sequence: number }>();
	if (!reply)
		throw new DomainError(
			"support_reply_required",
			409,
			"A recent support reply is required",
		);
	const config = await db
		.prepare(
			"SELECT id FROM notification_channel_configs WHERE enabled=1 AND channel='email' AND provider='cloudflare_email' AND from_address=? ORDER BY sort_order,id LIMIT 1",
		)
		.bind(supportReplyEmailSender)
		.first<{ id: string }>();
	if (!config)
		throw new DomainError(
			"support_email_sender_unavailable",
			503,
			"Approved support email sender unavailable",
		);
	const { runtime } = await telegramRuntime(db);
	const to = await decryptSecret(
		conversation.email_encrypted,
		runtime.dataEncryptionSecret,
		"telegram-web-support-email",
	);
	const locale = conversation.preferred_locale === "en-US" ? "en-US" : "zh-CN";
	const idempotencyKey = `support-manual-email:${conversation.id}:${reply.sequence}`;
	const subject =
		locale === "zh-CN"
			? "老实人AI VIP：客服已回复你的咨询"
			: "LaoshirenAI VIP: support has replied";
	const text =
		locale === "zh-CN"
			? "客服已回复你的在线咨询，请返回网页继续沟通：\nhttps://laoshirenvip.com/#support\n\n请使用此前咨询时的浏览器打开链接。站内消息和附件保存 2 天，请及时查看。\n这是一封提醒邮件，请勿直接回复。"
			: "Support has replied to your online conversation. Return to the website:\nhttps://laoshirenvip.com/#support\n\nOpen this link in the browser used for the original conversation. Messages and attachments are retained for 2 days.\nThis is a notification; please do not reply to this email.";
	let delivery: Awaited<ReturnType<typeof enqueueEmailNotification>>;
	try {
		delivery = await enqueueEmailNotification(db, {
			event: supportReplyEmailEvent,
			idempotencyKey,
			configId: config.id,
			locale,
			message: {
				to,
				from: supportReplyEmailSender,
				replyTo: "",
				subject,
				text,
				html: "",
			},
		});
	} catch (error) {
		const existing = await db
			.prepare(
				"SELECT id,status FROM notification_deliveries WHERE idempotency_key=?",
			)
			.bind(idempotencyKey)
			.first<{ id: string; status: string }>();
		if (!existing) throw error;
		delivery = { ...existing, duplicate: true };
	}
	await db
		.prepare(
			`INSERT INTO audit_logs (id,action,target_type,target_id,"after",created_at) VALUES (?,'support.email.manual_requested','notification_delivery',?,?,?) ON CONFLICT(id) DO NOTHING`,
		)
		.bind(
			`support-email:${delivery.id}`,
			delivery.id,
			JSON.stringify({
				telegramUserId: input.userId,
				conversationId: conversation.id,
				replySequence: reply.sequence,
			}),
			Date.now(),
		)
		.run();
	return delivery;
}
