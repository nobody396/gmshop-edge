import { Api } from "grammy";
import {
	loadTelegramSettings,
	telegramSettingKeys,
	upsertTelegramSetting,
} from "../settings";
import { telegramRuntime } from "./sync";

export const supportAdministratorMirrorFreshMs = 180_000;
export const supportAdministratorPeriodicSyncMs = 15 * 60_000;

type SupportAdministratorApi = Pick<Api, "getChatMember">;

export async function authorizeSupportAdministrator(
	db: D1Database,
	api: SupportAdministratorApi,
	input: {
		supportChatId: string;
		telegramUserId: string;
		lastAdminSyncAt: number | null;
		now?: number;
	},
) {
	const now = input.now ?? Date.now();
	const mirrored = await db
		.prepare(
			`SELECT 1 AS allowed FROM telegram_support_administrators
			 WHERE support_chat_id = ? AND telegram_user_id = ? LIMIT 1`,
		)
		.bind(input.supportChatId, input.telegramUserId)
		.first<{ allowed: number }>();
	if (
		input.lastAdminSyncAt &&
		input.lastAdminSyncAt >= now - supportAdministratorMirrorFreshMs
	)
		return Boolean(mirrored);
	try {
		const member = await api.getChatMember(
			input.supportChatId,
			Number(input.telegramUserId),
		);
		await updateSupportAdministratorMirror(
			db,
			input.supportChatId,
			input.telegramUserId,
			member.status,
		);
		return member.status === "administrator" || member.status === "creator";
	} catch {
		return false;
	}
}

export async function synchronizeSupportAdministrators(
	db: D1Database,
	now = Date.now(),
	supportChatId?: string | null,
) {
	const { settings, provider } = await telegramRuntime(db);
	const chatId =
		supportChatId === undefined ? settings.supportChatId : supportChatId;
	if (!chatId || !provider?.telegramBotToken || !provider.telegramBotUserId)
		return { available: false, administratorCount: 0 };
	const api = new Api(provider.telegramBotToken);
	const chat = await api.getChat(chatId);
	if (chat.type !== "supergroup" || !chat.is_forum)
		throw new TelegramSupportConfigurationError("support_chat_not_forum");
	const botMember = await api.getChatMember(
		chatId,
		Number(provider.telegramBotUserId),
	);
	if (
		botMember.status !== "administrator" ||
		!("can_manage_topics" in botMember) ||
		!botMember.can_manage_topics
	)
		throw new TelegramSupportConfigurationError("bot_cannot_manage_topics");
	const administrators = (await api.getChatAdministrators(chatId)).filter(
		(member) => !member.user.is_bot,
	);
	const statements = [
		db
			.prepare(
				"DELETE FROM telegram_support_administrators WHERE support_chat_id = ?",
			)
			.bind(chatId),
		...administrators.map((member) =>
			db
				.prepare(
					`INSERT INTO telegram_support_administrators
					 (support_chat_id, telegram_user_id, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.bind(chatId, String(member.user.id), member.status, now, now),
		),
		upsertTelegramSetting(db, telegramSettingKeys.lastAdminSyncAt, now, now),
	];
	await db.batch(statements);
	return {
		available: true,
		administratorCount: administrators.length,
		chatTitle: "title" in chat ? chat.title : null,
		forum: true,
		canManageTopics: true,
	};
}

export async function updateSupportAdministratorMirror(
	db: D1Database,
	chatId: string,
	userId: string,
	status: string,
) {
	const settings = await loadTelegramSettings(db);
	if (settings.supportChatId !== chatId) return;
	const now = Date.now();
	if (status === "administrator" || status === "creator") {
		await db
			.prepare(
				`INSERT INTO telegram_support_administrators
				 (support_chat_id, telegram_user_id, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(support_chat_id, telegram_user_id) DO UPDATE SET
				 status = excluded.status, updated_at = excluded.updated_at`,
			)
			.bind(chatId, userId, status, now, now)
			.run();
	} else {
		await db
			.prepare(
				`DELETE FROM telegram_support_administrators
				 WHERE support_chat_id = ? AND telegram_user_id = ?`,
			)
			.bind(chatId, userId)
			.run();
	}
	await upsertTelegramSetting(
		db,
		telegramSettingKeys.lastAdminSyncAt,
		now,
		now,
	).run();
}

export class TelegramSupportConfigurationError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "TelegramSupportConfigurationError";
	}
}
