import {
	Bot,
	type Context,
	GrammyError,
	InlineKeyboard,
	Keyboard,
} from "grammy";
import { storefrontCustomerRoleName } from "#/features/access/storefront-access";
import { telegramIdentityEmail } from "#/features/auth/identity-email";
import type { SupportedLocale } from "#/lib/locales";
import { m } from "#/paraglide/messages";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import {
	loadTelegramSettings,
	telegramSettingKeys,
	upsertTelegramSetting,
} from "../settings";
import {
	authorizeSupportAdministrator,
	updateSupportAdministratorMirror,
} from "./support-admins";
import { miniAppUrl, telegramRuntime } from "./sync";
import {
	closeWebConversationFromTopic,
	findWebConversationByTopic,
	storeWebAdministratorReply,
} from "./web-support";

type TelegramUser = {
	id: number;
	first_name: string;
	last_name?: string;
	username?: string;
	language_code?: string;
};

const botCache = new Map<string, Bot>();

export async function handleTelegramUpdate(db: D1Database, update: unknown) {
	const { runtime, settings, provider } = await telegramRuntime(db);
	if (
		settings.status !== "active" ||
		!provider?.telegramBotToken ||
		!provider.telegramBotUserId ||
		provider.revision !== settings.syncedRevision
	)
		return;
	const key = `${provider.telegramBotUserId}:${provider.revision}`;
	let bot = botCache.get(key);
	if (!bot) {
		bot = buildBot(provider.telegramBotToken, db, {
			origin: new URL(runtime.betterAuthUrl).origin,
			allowSignup: provider.allowSignup,
		});
		await bot.init();
		botCache.clear();
		botCache.set(key, bot);
	}
	await bot.handleUpdate(update as Parameters<Bot["handleUpdate"]>[0]);
}

function buildBot(
	token: string,
	db: D1Database,
	options: { origin: string; allowSignup: boolean },
) {
	const bot = new Bot(token);
	bot.command("start", async (ctx) => {
		const locale = await privateCommandLocale(ctx, db);
		if (!locale) return;
		await ctx.reply(text("welcome", locale), {
			reply_markup: appInlineKeyboard(options.origin, locale),
		});
	});
	bot.command("language", async (ctx) => {
		const account = await privateAccount(ctx, db, options.allowSignup);
		if (!account) return;
		await ctx.reply(text("language_choose", account.locale), {
			reply_markup: languageKeyboard(account.locale),
		});
	});
	bot.callbackQuery(/^language:(en-US|zh-CN)$/, async (ctx) => {
		const locale = ctx.match[1] as SupportedLocale;
		const from = ctx.from;
		await ctx.answerCallbackQuery();
		const limit = await claimFixedWindowRateLimit(db, {
			bucketKey: `telegram:user:${from.id}`,
			limit: 30,
			windowMs: 60_000,
		});
		if (!limit.allowed) return;
		await db
			.prepare(
				`UPDATE users SET preferred_locale = ?, updated_at = ? WHERE id = (
				 SELECT user_id FROM accounts WHERE provider_id = 'telegram'
				 AND account_id = ? LIMIT 1)`,
			)
			.bind(locale, Date.now(), String(from.id))
			.run();
		await ctx.editMessageText(text("language_choose", locale), {
			reply_markup: languageKeyboard(locale),
		});
		await ctx.reply(text("language_updated", locale), {
			reply_markup: appKeyboard(options.origin, locale),
		});
	});
	bot.command("support", (ctx) => beginSupport(ctx, db, options.allowSignup));
	bot.callbackQuery("support:open", async (ctx) => {
		await ctx.answerCallbackQuery();
		await beginSupport(ctx, db, options.allowSignup);
	});
	bot.command("close", async (ctx) => {
		const account = await privateAccount(ctx, db, options.allowSignup);
		if (!account) return;
		await closeSupportConversation(db, ctx, account.locale);
	});
	bot.command("help", async (ctx) => {
		const locale = await privateCommandLocale(ctx, db);
		if (!locale) return;
		await ctx.reply(text("help", locale));
	});
	bot.on("chat_member", async (ctx) => {
		const member = ctx.chatMember.new_chat_member;
		if (member.user.is_bot) return;
		await updateSupportAdministratorMirror(
			db,
			String(ctx.chat.id),
			String(member.user.id),
			member.status,
		);
	});
	bot.on("my_chat_member", async (ctx) => {
		const settings = await loadTelegramSettings(db);
		if (settings.supportChatId !== String(ctx.chat.id)) return;
		const member = ctx.myChatMember.new_chat_member;
		const canManageTopics =
			member.status === "administrator" &&
			"can_manage_topics" in member &&
			member.can_manage_topics;
		if (!canManageTopics)
			await upsertTelegramSetting(
				db,
				telegramSettingKeys.lastAdminSyncAt,
				null,
				Date.now(),
			).run();
	});
	bot.on("message", async (ctx) => {
		if (ctx.message.chat.type === "private") {
			if (ctx.message.text?.startsWith("/")) {
				const locale = await privateCommandLocale(ctx, db);
				if (locale) await ctx.reply(text("help", locale));
				return;
			}
			await forwardCustomerMessage(db, ctx, options.allowSignup);
			return;
		}
		if ("forum_topic_closed" in ctx.message) {
			await recordAdministratorTopicClose(db, ctx);
			return;
		}
		await relayAdministratorMessage(db, ctx);
	});
	bot.catch(({ error }) => {
		console.error(
			JSON.stringify({
				event: "telegram_update_failed",
				code: errorCode(error),
			}),
		);
		throw error;
	});
	return bot;
}

async function beginSupport(
	ctx: Context,
	db: D1Database,
	allowSignup: boolean,
) {
	const initialLocale = await privateCommandLocale(ctx, db);
	if (!initialLocale || !ctx.from || ctx.chat?.type !== "private") return;
	const progress = await ctx.reply(text("support_connecting", initialLocale));
	try {
		const account = await ensureTelegramAccount(db, ctx.from, allowSignup);
		if (!account) {
			await editSupportProgress(
				ctx,
				progress.message_id,
				text("support_unavailable", initialLocale),
			);
			return;
		}
		const result = await openSupportConversation(
			db,
			ctx,
			account.userId,
			account.locale,
		);
		await editSupportProgress(
			ctx,
			progress.message_id,
			text(
				result === "opened" ? "support_opened" : "support_unavailable",
				account.locale,
			),
		);
	} catch (error) {
		await editSupportProgress(
			ctx,
			progress.message_id,
			text("support_failed", initialLocale),
		);
		throw error;
	}
}

async function privateAccount(
	ctx: Context,
	db: D1Database,
	allowSignup: boolean,
) {
	if (!ctx.from || ctx.chat?.type !== "private") return null;
	const limit = await claimFixedWindowRateLimit(db, {
		bucketKey: `telegram:user:${ctx.from.id}`,
		limit: 30,
		windowMs: 60_000,
	});
	if (!limit.allowed) return null;
	return ensureTelegramAccount(db, ctx.from, allowSignup);
}

async function privateCommandLocale(ctx: Context, db: D1Database) {
	if (!ctx.from || ctx.chat?.type !== "private") return null;
	const limit = await claimFixedWindowRateLimit(db, {
		bucketKey: `telegram:user:${ctx.from.id}`,
		limit: 30,
		windowMs: 60_000,
	});
	return limit.allowed ? telegramUserLocale(ctx.from) : null;
}

function telegramUserLocale(user: TelegramUser): SupportedLocale {
	return user.language_code?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

async function ensureTelegramAccount(
	db: D1Database,
	user: TelegramUser,
	allowSignup: boolean,
) {
	const existing = await db
		.prepare(
			`SELECT u.id, u.preferred_locale, u.enabled FROM users u
			 JOIN accounts a ON a.user_id = u.id
			 WHERE a.provider_id = 'telegram' AND a.account_id = ? LIMIT 1`,
		)
		.bind(String(user.id))
		.first<{
			id: string;
			preferred_locale: SupportedLocale;
			enabled: number;
		}>();
	if (existing)
		return existing.enabled
			? { userId: existing.id, locale: existing.preferred_locale }
			: null;
	if (!allowSignup) return null;
	const now = Date.now();
	const userId = crypto.randomUUID();
	const locale = telegramUserLocale(user);
	const name = topicDisplayName(user);
	await db.batch([
		db
			.prepare(
				`INSERT INTO users
				 (id, name, email, email_verified, preferred_locale, telegram_id,
				  telegram_username, enabled, role_ids, created_at, updated_at)
				 VALUES (?, ?, ?, 0, ?, ?, ?, 1, (
				  SELECT json_array(id) FROM roles
				  WHERE name = ? AND built_in = 1 AND enabled = 1 LIMIT 1
				 ), ?, ?)
				 ON CONFLICT(email) DO NOTHING`,
			)
			.bind(
				userId,
				name,
				telegramIdentityEmail(String(user.id)),
				locale,
				String(user.id),
				user.username ?? null,
				storefrontCustomerRoleName,
				now,
				now,
			),
		db
			.prepare(
				`INSERT INTO accounts
				 (id, user_id, account_id, provider_id, telegram_id,
				  telegram_username, created_at, updated_at)
				 SELECT ?, id, ?, 'telegram', ?, ?, ?, ? FROM users WHERE email = ?
				 ON CONFLICT(provider_id, account_id) DO NOTHING`,
			)
			.bind(
				crypto.randomUUID(),
				String(user.id),
				String(user.id),
				user.username ?? null,
				now,
				now,
				telegramIdentityEmail(String(user.id)),
			),
	]);
	const created = await db
		.prepare(
			"SELECT user_id FROM accounts WHERE provider_id = 'telegram' AND account_id = ?",
		)
		.bind(String(user.id))
		.first<{ user_id: string }>();
	return created ? { userId: created.user_id, locale } : null;
}

async function openSupportConversation(
	db: D1Database,
	ctx: Context,
	userId: string,
	locale: SupportedLocale,
) {
	if (!ctx.from || ctx.chat?.type !== "private") return "unavailable" as const;
	const settings = await loadTelegramSettings(db);
	const existing = await conversationForUser(
		db,
		settings.supportChatId,
		ctx.from.id,
	);
	if (
		!settings.supportChatId ||
		(!settings.supportEnabled &&
			existing?.status !== "active" &&
			existing?.status !== "closing")
	) {
		return "unavailable" as const;
	}
	if (existing?.status === "active" || existing?.status === "closing") {
		if (existing.status === "closing") await restoreActive(db, existing.id);
		await touchConversation(db, existing.id);
		return "opened" as const;
	}
	const now = Date.now();
	if (existing?.status === "creating") {
		if ((existing.creation_lease_expires_at ?? now + 1) > now)
			return "unavailable" as const;
		await db
			.prepare(
				`DELETE FROM telegram_support_conversations WHERE id = ?
				 AND status = 'creating' AND creation_lease_expires_at <= ?`,
			)
			.bind(existing.id, now)
			.run();
		return openSupportConversation(db, ctx, userId, locale);
	}
	const topicName = topicNameFor(ctx.from);
	if (existing?.message_thread_id) {
		let threadId = existing.message_thread_id;
		try {
			await ctx.api.reopenForumTopic(settings.supportChatId, threadId);
		} catch (error) {
			if (isTopicUnchangedError(error)) {
				// The Forum topic is already open; the D1 state still needs reopening.
			} else if (isMissingTopicError(error)) {
				threadId = (
					await ctx.api.createForumTopic(settings.supportChatId, topicName)
				).message_thread_id;
			} else {
				throw error;
			}
		}
		await db
			.prepare(
				`UPDATE telegram_support_conversations SET status = 'active', topic_name = ?,
				 message_thread_id = ?,
				 opened_at = ?, closed_at = NULL, closed_reason = NULL,
				 last_activity_at = ?, updated_at = ? WHERE id = ?`,
			)
			.bind(topicName, threadId, now, now, now, existing.id)
			.run();
		await ctx.api.sendMessage(
			settings.supportChatId,
			text("topic_opened", locale),
			{ message_thread_id: threadId },
		);
		return "opened" as const;
	}
	if (existing)
		await db
			.prepare(
				"DELETE FROM telegram_support_conversations WHERE id = ? AND status = 'closed'",
			)
			.bind(existing.id)
			.run();
	const id = crypto.randomUUID();
	const reserved = await db
		.prepare(
			`INSERT INTO telegram_support_conversations
			 (id, support_chat_id, telegram_user_id, customer_chat_id, user_id,
			  topic_name, status, creation_lease_expires_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)
			 ON CONFLICT(support_chat_id, telegram_user_id) DO NOTHING`,
		)
		.bind(
			id,
			settings.supportChatId,
			String(ctx.from.id),
			String(ctx.chat.id),
			userId,
			topicName,
			now + 30_000,
			now,
			now,
		)
		.run();
	if (Number(reserved.meta.changes ?? 0) !== 1) return "unavailable" as const;
	try {
		const topic = await ctx.api.createForumTopic(
			settings.supportChatId,
			topicName,
		);
		await db
			.prepare(
				`UPDATE telegram_support_conversations SET message_thread_id = ?,
				 status = 'active', creation_lease_expires_at = NULL, opened_at = ?,
				 last_activity_at = ?, updated_at = ? WHERE id = ?`,
			)
			.bind(topic.message_thread_id, now, now, now, id)
			.run();
		await ctx.api.sendMessage(
			settings.supportChatId,
			text("topic_opened", locale),
			{
				message_thread_id: topic.message_thread_id,
			},
		);
		return "opened" as const;
	} catch (error) {
		await db
			.prepare("DELETE FROM telegram_support_conversations WHERE id = ?")
			.bind(id)
			.run();
		throw error;
	}
}

function editSupportProgress(ctx: Context, messageId: number, value: string) {
	if (!ctx.chat) return Promise.resolve();
	return ctx.api.editMessageText(ctx.chat.id, messageId, value);
}

async function closeSupportConversation(
	db: D1Database,
	ctx: Context,
	locale: SupportedLocale,
) {
	if (!ctx.from) return;
	const settings = await loadTelegramSettings(db);
	const conversation = await conversationForUser(
		db,
		settings.supportChatId,
		ctx.from.id,
	);
	if (
		!conversation ||
		conversation.status !== "active" ||
		!conversation.message_thread_id
	) {
		await ctx.reply(text("support_closed", locale));
		return;
	}
	const now = Date.now();
	const claimed = await db
		.prepare(
			`UPDATE telegram_support_conversations SET status = 'closing', updated_at = ?
			 WHERE id = ? AND status = 'active'`,
		)
		.bind(now, conversation.id)
		.run();
	if (Number(claimed.meta.changes ?? 0) !== 1) {
		await ctx.reply(text("support_closed", locale));
		return;
	}
	try {
		await ctx.api.sendMessage(
			conversation.support_chat_id,
			m.telegram_support_topic_closed({}, { locale }),
			{ message_thread_id: conversation.message_thread_id },
		);
		await ctx.api.closeForumTopic(
			conversation.support_chat_id,
			conversation.message_thread_id,
		);
		await db
			.prepare(
				`UPDATE telegram_support_conversations SET status = 'closed',
				 closed_at = ?, closed_reason = 'customer', updated_at = ?
				 WHERE id = ? AND status = 'closing'`,
			)
			.bind(now, now, conversation.id)
			.run();
	} catch (error) {
		await restoreActive(db, conversation.id);
		throw error;
	}
	await ctx.reply(text("support_closed", locale));
}

async function forwardCustomerMessage(
	db: D1Database,
	ctx: Context,
	allowSignup: boolean,
) {
	const account = await privateAccount(ctx, db, allowSignup);
	if (!account || !ctx.message || !ctx.from) return;
	const settings = await loadTelegramSettings(db);
	const conversation = await conversationForUser(
		db,
		settings.supportChatId,
		ctx.from.id,
	);
	if (
		!conversation ||
		!(["active", "closing"] as const).includes(
			conversation.status as "active" | "closing",
		) ||
		!conversation.message_thread_id
	) {
		await ctx.reply(text("support_send_first", account.locale));
		return;
	}
	if (!supportedMessage(ctx.message)) return;
	if (conversation.status === "closing")
		await restoreActive(db, conversation.id);
	try {
		await ctx.api.forwardMessage(
			conversation.support_chat_id,
			ctx.message.chat.id,
			ctx.message.message_id,
			{ message_thread_id: conversation.message_thread_id },
		);
	} catch (error) {
		if (!isMissingTopicError(error)) throw error;
		const topic = await ctx.api.createForumTopic(
			conversation.support_chat_id,
			topicNameFor(ctx.from),
		);
		await db
			.prepare(
				`UPDATE telegram_support_conversations SET message_thread_id = ?,
				 status = 'active', updated_at = ? WHERE id = ? AND status != 'closed'`,
			)
			.bind(topic.message_thread_id, Date.now(), conversation.id)
			.run();
		await ctx.api.forwardMessage(
			conversation.support_chat_id,
			ctx.message.chat.id,
			ctx.message.message_id,
			{ message_thread_id: topic.message_thread_id },
		);
	}
	await touchConversation(db, conversation.id);
}

async function relayAdministratorMessage(db: D1Database, ctx: Context) {
	const message = ctx.message;
	if (
		!message ||
		!ctx.from ||
		message.sender_chat ||
		ctx.from.is_bot ||
		message.text?.startsWith("/")
	)
		return;
	const settings = await loadTelegramSettings(db);
	if (
		!settings.supportChatId ||
		String(message.chat.id) !== settings.supportChatId
	)
		return;
	if (!message.message_thread_id) return;
	const administrator = await authorizeSupportAdministrator(db, ctx.api, {
		supportChatId: settings.supportChatId,
		telegramUserId: String(ctx.from.id),
		lastAdminSyncAt: settings.lastAdminSyncAt,
	});
	if (!administrator) return;
	const webConversation = await findWebConversationByTopic(
		db,
		settings.supportChatId,
		message.message_thread_id,
	);
	if (webConversation) {
		const limit = await claimFixedWindowRateLimit(db, {
			bucketKey: `telegram:admin:${ctx.from.id}`,
			limit: 60,
			windowMs: 60_000,
		});
		if (!limit.allowed) return;
		if (!message.text) {
			await ctx.api.sendMessage(
				settings.supportChatId,
				"Web support currently supports text replies only.",
				{ message_thread_id: message.message_thread_id },
			);
			return;
		}
		await storeWebAdministratorReply(db, webConversation, message.text);
		return;
	}
	if (!supportedMessage(message)) return;
	const conversation = await db
		.prepare(
			`SELECT id, customer_chat_id FROM telegram_support_conversations
			 WHERE support_chat_id = ? AND message_thread_id = ?
			 AND status IN ('active', 'closing')
			 LIMIT 1`,
		)
		.bind(settings.supportChatId, message.message_thread_id)
		.first<{ id: string; customer_chat_id: string }>();
	if (!conversation) return;
	const limit = await claimFixedWindowRateLimit(db, {
		bucketKey: `telegram:admin:${ctx.from.id}`,
		limit: 60,
		windowMs: 60_000,
	});
	if (!limit.allowed) return;
	await restoreActive(db, conversation.id);
	await ctx.api.copyMessage(
		conversation.customer_chat_id,
		message.chat.id,
		message.message_id,
	);
	await touchConversation(db, conversation.id);
}

async function recordAdministratorTopicClose(db: D1Database, ctx: Context) {
	if (!ctx.message?.message_thread_id) return;
	const settings = await loadTelegramSettings(db);
	if (settings.supportChatId !== String(ctx.message.chat.id)) return;
	const webClosed = await closeWebConversationFromTopic(
		db,
		settings.supportChatId,
		ctx.message.message_thread_id,
	);
	if (Number(webClosed.meta.changes ?? 0) > 0) return;
	const conversation = await db
		.prepare(
			`SELECT c.id, c.customer_chat_id, u.preferred_locale
			 FROM telegram_support_conversations c JOIN users u ON u.id = c.user_id
			 WHERE c.support_chat_id = ? AND c.message_thread_id = ?
			 AND c.status = 'active' LIMIT 1`,
		)
		.bind(settings.supportChatId, ctx.message.message_thread_id)
		.first<{
			id: string;
			customer_chat_id: string;
			preferred_locale: SupportedLocale;
		}>();
	if (!conversation) return;
	const now = Date.now();
	await db
		.prepare(
			`UPDATE telegram_support_conversations SET status = 'closed', closed_at = ?,
			 closed_reason = 'administrator', updated_at = ?
			 WHERE id = ? AND status = 'active'`,
		)
		.bind(now, now, conversation.id)
		.run();
	await ctx.api.sendMessage(
		conversation.customer_chat_id,
		text("support_closed", conversation.preferred_locale),
	);
}

function conversationForUser(
	db: D1Database,
	supportChatId: string | null,
	userId: number,
) {
	if (!supportChatId) return null;
	return db
		.prepare(
			`SELECT id, support_chat_id, customer_chat_id, message_thread_id, status,
			 creation_lease_expires_at
			 FROM telegram_support_conversations WHERE support_chat_id = ?
			 AND telegram_user_id = ? LIMIT 1`,
		)
		.bind(supportChatId, String(userId))
		.first<{
			id: string;
			support_chat_id: string;
			customer_chat_id: string;
			message_thread_id: number | null;
			status: string;
			creation_lease_expires_at: number | null;
		}>();
}

function touchConversation(db: D1Database, id: string) {
	const now = Date.now();
	return db
		.prepare(
			"UPDATE telegram_support_conversations SET last_activity_at = ?, updated_at = ? WHERE id = ?",
		)
		.bind(now, now, id)
		.run();
}

function restoreActive(db: D1Database, id: string) {
	const now = Date.now();
	return db
		.prepare(
			`UPDATE telegram_support_conversations SET status = 'active',
			 last_activity_at = ?, updated_at = ? WHERE id = ? AND status = 'closing'`,
		)
		.bind(now, now, id)
		.run();
}

function appKeyboard(origin: string, locale: SupportedLocale) {
	return new Keyboard()
		.webApp(buttonLabel("shop", locale), miniAppUrl(origin, "shop"))
		.row()
		.webApp(buttonLabel("orders", locale), miniAppUrl(origin, "orders"))
		.webApp(buttonLabel("account", locale), miniAppUrl(origin, "account"))
		.resized()
		.persistent();
}

function appInlineKeyboard(origin: string, locale: SupportedLocale) {
	return new InlineKeyboard()
		.webApp(buttonLabel("orders", locale), miniAppUrl(origin, "orders"))
		.webApp(buttonLabel("account", locale), miniAppUrl(origin, "account"))
		.row()
		.webApp(
			{ text: buttonLabel("shop", locale), style: "primary" },
			miniAppUrl(origin, "shop"),
		)
		.text(
			{ text: m.telegram_button_support({}, { locale }), style: "success" },
			"support:open",
		);
}

function languageKeyboard(locale: SupportedLocale) {
	return new InlineKeyboard()
		.text(
			{
				text: `${locale === "zh-CN" ? "✓ " : ""}简体中文`,
				style: locale === "zh-CN" ? "success" : undefined,
			},
			"language:zh-CN",
		)
		.text(
			{
				text: `${locale === "en-US" ? "✓ " : ""}English`,
				style: locale === "en-US" ? "success" : undefined,
			},
			"language:en-US",
		);
}

function buttonLabel(
	target: "shop" | "orders" | "account",
	locale: SupportedLocale,
) {
	const options = { locale } as const;
	if (target === "shop") return m.telegram_button_shop({}, options);
	if (target === "orders") return m.telegram_button_orders({}, options);
	return m.telegram_button_account({}, options);
}

function text(
	key:
		| "welcome"
		| "help"
		| "language_choose"
		| "language_updated"
		| "support_opened"
		| "support_connecting"
		| "support_failed"
		| "support_closed"
		| "support_unavailable"
		| "support_send_first"
		| "topic_opened",
	locale: SupportedLocale,
) {
	const options = { locale } as const;
	const messages = {
		welcome: m.telegram_welcome,
		help: m.telegram_help,
		language_choose: m.telegram_language_choose,
		language_updated: m.telegram_language_updated,
		support_opened: m.telegram_support_opened,
		support_connecting: m.telegram_support_connecting,
		support_failed: m.telegram_support_failed,
		support_closed: m.telegram_support_closed,
		support_unavailable: m.telegram_support_unavailable,
		support_send_first: m.telegram_support_send_first,
		topic_opened: m.telegram_support_topic_opened,
	};
	return messages[key]({}, options);
}

function topicNameFor(user: TelegramUser) {
	const suffix = String(user.id);
	const prefix = user.username ? `@${user.username}` : topicDisplayName(user);
	return `${Array.from(prefix, (character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127 ? " " : character;
	})
		.join("")
		.trim()
		.slice(0, Math.max(1, 125 - suffix.length))} · ${suffix}`;
}

function topicDisplayName(user: TelegramUser) {
	return (
		[user.first_name, user.last_name].filter(Boolean).join(" ") ||
		`Telegram ${user.id}`
	);
}

function supportedMessage(message: object) {
	const value = message as Record<string, unknown>;
	return Boolean(
		value.text || value.photo || value.document || value.video || value.voice,
	);
}

function errorCode(error: unknown) {
	return error instanceof Error ? error.name : "unknown";
}

function isMissingTopicError(error: unknown) {
	return (
		error instanceof GrammyError &&
		/(message thread not found|topic_closed|topic deleted)/i.test(
			error.description,
		)
	);
}

function isTopicUnchangedError(error: unknown) {
	return (
		error instanceof GrammyError &&
		/topic_not_modified/i.test(error.description)
	);
}
