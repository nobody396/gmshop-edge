import type { Api } from "grammy";
import { z } from "zod";
import type { SupportedLocale } from "#/lib/locales";
import { m } from "#/paraglide/messages";
import { loadTelegramSettings } from "../settings";
import { authorizeSupportAdministrator } from "./support-admins";

export const supportAwaySettingKey = "telegram.support.away_mode";
export const supportAwayReceiptNamespace = "telegram_support_away";
const guideSchema = z
	.url()
	.max(2048)
	.refine((value) => {
		try {
			const url = new URL(value);
			return (
				url.protocol === "https:" &&
				!url.username &&
				!url.password &&
				!url.port &&
				[
					"laoshirenvip.com",
					"cn.laoshirenvip.com",
					"shop.laoshirenai.com",
				].includes(url.hostname)
			);
		} catch {
			return false;
		}
	});
const modeSchema = z
	.object({
		enabled: z.boolean(),
		roundId: z.uuid().nullable(),
		startedAt: z.number().int().nonnegative().nullable(),
		guideUrl: guideSchema.nullable(),
		supportChatId: z.string().nullable(),
	})
	.refine(
		(value) =>
			!value.enabled ||
			Boolean(
				value.roundId &&
					value.startedAt &&
					value.guideUrl &&
					value.supportChatId,
			),
	);
type AwayMode = z.infer<typeof modeSchema>;

export async function loadSupportAwayMode(db: D1Database): Promise<AwayMode> {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key=?")
		.bind(supportAwaySettingKey)
		.first<{ value: string }>();
	try {
		const value = modeSchema.safeParse(JSON.parse(row?.value ?? "null"));
		if (value.success) return value.data;
	} catch {
		/* Invalid stored settings must not enable replies. */
	}
	return {
		enabled: false,
		roundId: null,
		startedAt: null,
		guideUrl: null,
		supportChatId: null,
	};
}

export async function supportAwayCommand(
	db: D1Database,
	api: Pick<Api, "getChatMember">,
	input: {
		chatId: string;
		userId: string;
		argument: string;
		locale: SupportedLocale;
	},
) {
	const settings = await loadTelegramSettings(db);
	if (
		input.chatId !== settings.supportChatId ||
		!(await authorizeSupportAdministrator(db, api, {
			supportChatId: input.chatId,
			telegramUserId: input.userId,
			lastAdminSyncAt: settings.lastAdminSyncAt,
		}))
	)
		return null;
	let mode = await loadSupportAwayMode(db);
	const argument = input.argument.trim();
	if (argument && argument !== "status") {
		let next: AwayMode;
		if (argument.startsWith("guide ")) {
			const guide = guideSchema.safeParse(argument.slice(6).trim());
			if (!guide.success)
				return m.telegram_away_invalid_guide({}, { locale: input.locale });
			next = {
				enabled: false,
				roundId: null,
				startedAt: null,
				guideUrl: guide.data,
				supportChatId: input.chatId,
			};
		} else if (argument === "on") {
			if (!mode.guideUrl || mode.supportChatId !== input.chatId)
				return m.telegram_away_guide_required({}, { locale: input.locale });
			next = {
				...mode,
				enabled: true,
				roundId: mode.enabled ? mode.roundId : crypto.randomUUID(),
				startedAt: mode.enabled ? mode.startedAt : Date.now(),
			};
		} else if (argument === "off") {
			next = { ...mode, enabled: false };
		} else return m.telegram_away_usage({}, { locale: input.locale });
		const now = Date.now();
		await db.batch([
			db
				.prepare(`INSERT INTO system_settings (key,value,created_at,updated_at) VALUES (?,?,?,?)
              ON CONFLICT(key) DO UPDATE SET value=CASE
                WHEN ?=1 AND json_extract(system_settings.value,'$.enabled')=1
                 AND json_extract(system_settings.value,'$.supportChatId')=? THEN system_settings.value
                ELSE excluded.value END, updated_at=excluded.updated_at`)
				.bind(
					supportAwaySettingKey,
					JSON.stringify(next),
					now,
					now,
					argument === "on" ? 1 : 0,
					input.chatId,
				),
			db
				.prepare(`INSERT INTO audit_logs (id,action,target_type,target_id,after,created_at)
              SELECT ?, 'telegram.support.away', 'telegram_support', ?,
                json_object('telegramUserId',?,'mode',json(value)), ? FROM system_settings WHERE key=?`)
				.bind(
					crypto.randomUUID(),
					input.chatId,
					input.userId,
					now,
					supportAwaySettingKey,
				),
		]);
		mode = await loadSupportAwayMode(db);
	}
	return mode.enabled
		? m.telegram_away_enabled_status(
				{ guideUrl: mode.guideUrl ?? "" },
				{ locale: input.locale },
			)
		: m.telegram_away_disabled_status(
				{ guideUrl: mode.guideUrl ?? "" },
				{ locale: input.locale },
			);
}

/** Reserve before delivery; uncertain delivery is never retried in this round. */
export async function reserveSupportAwayReply(
	db: D1Database,
	input: {
		chatId: string;
		conversationId: string;
		kind: "web" | "telegram";
		locale: SupportedLocale;
		messageTimeMs?: number;
	},
) {
	const settings = await loadTelegramSettings(db);
	const mode = await loadSupportAwayMode(db);
	if (
		!mode.enabled ||
		!mode.roundId ||
		!mode.guideUrl ||
		mode.supportChatId !== input.chatId ||
		settings.supportChatId !== input.chatId ||
		!(input.kind === "web"
			? settings.webSupportEnabled
			: settings.supportEnabled)
	)
		return null;
	if (
		input.messageTimeMs !== undefined &&
		Math.floor(input.messageTimeMs / 1000) <
			Math.floor((mode.startedAt ?? 0) / 1000)
	)
		return null;
	const conversation =
		input.kind === "web"
			? await db
					.prepare(`SELECT message_thread_id,locale FROM telegram_web_support_conversations
            WHERE id=? AND support_chat_id=? AND status IN ('active','closing')`)
					.bind(input.conversationId, input.chatId)
					.first<{
						message_thread_id: number | null;
						locale: SupportedLocale | null;
					}>()
			: await db
					.prepare(`SELECT message_thread_id,customer_chat_id FROM telegram_support_conversations
            WHERE id=? AND support_chat_id=? AND status IN ('active','closing')`)
					.bind(input.conversationId, input.chatId)
					.first<{
						message_thread_id: number | null;
						customer_chat_id: string;
					}>();
	if (!conversation?.message_thread_id) return null;
	const locale =
		"locale" in conversation
			? (conversation.locale ?? input.locale)
			: input.locale;
	const message =
		m.telegram_away_customer_message({ guideUrl: mode.guideUrl }, { locale }) +
		(input.kind === "web" ? m.telegram_away_email_notice({}, { locale }) : "");
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(message),
	);
	const receiptId = crypto.randomUUID();
	const now = Date.now();
	const result = await db
		.prepare(`INSERT INTO replay_receipts
      (id,namespace,scope_id,external_id,event_type,payload_digest,status,created_at,updated_at)
      SELECT ?,?,?,?,'away_reply',?,'received',?,? FROM system_settings
      WHERE key=? AND json_extract(value,'$.enabled')=1 AND json_extract(value,'$.roundId')=?
       AND json_extract(value,'$.guideUrl')=? AND json_extract(value,'$.supportChatId')=?
       AND (SELECT json_extract(value,'$') FROM system_settings WHERE key='telegram.support.chat_id')=?
      ON CONFLICT(namespace,scope_id,external_id) DO NOTHING`)
		.bind(
			receiptId,
			supportAwayReceiptNamespace,
			mode.roundId,
			`${input.kind}:${input.conversationId}`,
			Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join(""),
			now,
			now,
			supportAwaySettingKey,
			mode.roundId,
			mode.guideUrl,
			input.chatId,
			input.chatId,
		)
		.run();
	if (Number(result.meta.changes ?? 0) !== 1) return null;
	return {
		receiptId,
		message,
		threadId: conversation.message_thread_id,
		customerChatId:
			"customer_chat_id" in conversation ? conversation.customer_chat_id : null,
	};
}

export function completeSupportAwayReply(
	db: D1Database,
	receiptId: string,
	sent: boolean,
) {
	const now = Date.now();
	return db
		.prepare(
			`UPDATE replay_receipts SET status=?,failure_code=?,processed_at=?,updated_at=? WHERE id=?`,
		)
		.bind(
			sent ? "processed" : "failed",
			sent ? null : "away_delivery_uncertain",
			now,
			now,
			receiptId,
		)
		.run();
}
