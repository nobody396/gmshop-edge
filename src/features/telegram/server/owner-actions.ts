import { z } from "zod";
import { beijingClock } from "#/features/ops-automation/server/shared";
import { DomainError } from "#/lib/domain-error";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { upsertFeishuAlertSetting } from "./feishu-alerts";
import {
	callTelegram,
	resolveTelegramOwnerAlertCredentials,
	sendOwnerAlert,
	type TelegramOwnerAlertCredentials,
	telegramOwnerAlertSettingKeys,
} from "./owner-alerts";
import { constantTimeStringEqual } from "./secret";
import { telegramRuntime } from "./sync";

/**
 * Owner approvals as Telegram inline buttons on the owner-alert bot. A
 * proposal is one `owner_action_requests` row; a tap is accepted only from the
 * owner-alert chat, only from its creator, and only once.
 */

export const ownerActionTtlMs = 7 * 86_400_000;
export const ownerWebhookPath = "/api/telegram/owner-webhook";
const webhookRetryMs = 3_600_000;
/** A claim older than this is presumed lost (crashed request) and may be retried. */
const processingLeaseMs = 5 * 60_000;

const callbackPattern = /^oa:([0-9a-f-]{36}):(\d|x)$/;

export type OwnerActionContext = {
	db: D1Database;
	cache: KVNamespace | undefined;
	now: number;
};

/** Returns the line appended to the message after a successful approval. */
type OwnerActionHandler = (
	context: OwnerActionContext,
	payload: unknown,
	choice: number,
) => Promise<string>;

// Loaded lazily: the handlers' modules import this one to send proposals.
const handlers: Record<string, () => Promise<OwnerActionHandler>> = {
	supplier_rebind: async () =>
		(await import("#/features/suppliers/server/rebind-proposal"))
			.approveSupplierRebind,
};

type Fetcher = typeof fetch;

/**
 * Sends `text` with one button per choice plus a reject button. Without a
 * working button webhook the text goes out as a plain alert with `fallback`
 * appended, so the owner never sees a button that does nothing.
 */
export async function proposeOwnerAction(
	db: D1Database,
	input: {
		kind: keyof typeof handlers;
		payload: unknown;
		text: string;
		choices: string[];
		rejectLabel: string;
		fallback: string;
		now: number;
		fetcher?: Fetcher;
	},
) {
	const request = input.fetcher ?? fetch;
	const credentials = await resolveTelegramOwnerAlertCredentials(db);
	if (!credentials || !(await ownerWebhookReady(db))) {
		await sendOwnerAlert(db, `${input.text}\n\n${input.fallback}`, {
			fetcher: request,
		});
		return null;
	}
	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT INTO owner_action_requests
			 (id, kind, payload, message_text, status, expires_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
		)
		.bind(
			id,
			input.kind,
			JSON.stringify(input.payload),
			input.text,
			input.now + ownerActionTtlMs,
			input.now,
			input.now,
		)
		.run();
	const message = z.object({ message_id: z.number().int() }).parse(
		await callTelegram(
			credentials,
			"sendMessage",
			{
				chat_id: credentials.chatId,
				text: input.text,
				link_preview_options: { is_disabled: true },
				reply_markup: {
					inline_keyboard: [
						...input.choices.map((label, index) => [
							{ text: label, callback_data: `oa:${id}:${index}` },
						]),
						[{ text: input.rejectLabel, callback_data: `oa:${id}:x` }],
					],
				},
			},
			request,
			"telegram_alert_delivery_failed",
		),
	);
	await db
		.prepare(
			`UPDATE owner_action_requests SET chat_id = ?, message_id = ?
			 WHERE id = ?`,
		)
		.bind(credentials.chatId, message.message_id, id)
		.run();
	return { id };
}

const callbackQuerySchema = z.object({
	id: z.string(),
	data: z.string().optional(),
	from: z.object({
		id: z.number().int(),
		is_bot: z.boolean().optional(),
		first_name: z.string().optional(),
	}),
	message: z
		.object({
			message_id: z.number().int(),
			chat: z.object({ id: z.number().int() }),
		})
		.optional(),
});

type ActionRow = {
	id: string;
	kind: string;
	payload: string;
	message_text: string;
	status: string;
	chat_id: string | null;
	message_id: number | null;
};

export async function handleOwnerActionCallback(
	context: OwnerActionContext & { fetcher?: Fetcher },
	rawCallback: unknown,
) {
	const request = context.fetcher ?? fetch;
	const parsed = callbackQuerySchema.safeParse(rawCallback);
	if (!parsed.success) return { handled: false as const };
	const callback = parsed.data;
	const match = callbackPattern.exec(callback.data ?? "");
	const credentials = await resolveTelegramOwnerAlertCredentials(context.db);
	if (!match || !credentials || !callback.message)
		return { handled: false as const };
	const answer = (text: string) =>
		callTelegram(
			credentials,
			"answerCallbackQuery",
			{ callback_query_id: callback.id, text, show_alert: false },
			request,
			"telegram_alert_delivery_failed",
		).catch(() => undefined);
	const [, id, choiceText] = match;
	const chatId = String(callback.message.chat.id);
	if (chatId !== credentials.chatId || callback.from.is_bot) {
		await answer("无权限");
		return { handled: true as const, status: "forbidden" };
	}
	if (!(await isChatCreator(credentials, callback.from.id, request))) {
		await answer("只有群主可以操作");
		return { handled: true as const, status: "forbidden" };
	}
	const decidedBy = String(callback.from.id);
	const claimed = await context.db
		.prepare(
			`UPDATE owner_action_requests SET status = 'processing',
			 decided_by = ?, decided_at = ?, updated_at = ?
			 WHERE id = ? AND expires_at > ? AND chat_id = ? AND message_id = ?
			  AND (status = 'pending' OR (status = 'processing' AND decided_at < ?))`,
		)
		.bind(
			decidedBy,
			context.now,
			context.now,
			id,
			context.now,
			chatId,
			callback.message.message_id,
			context.now - processingLeaseMs,
		)
		.run();
	const row = await context.db
		.prepare(
			`SELECT id, kind, payload, message_text, status, chat_id, message_id
			 FROM owner_action_requests WHERE id = ?`,
		)
		.bind(id)
		.first<ActionRow>();
	if (Number(claimed.meta.changes ?? 0) !== 1 || !row) {
		await answer(row ? "这条已经处理过或已过期" : "找不到这条请求");
		return { handled: true as const, status: "stale" };
	}
	const clock = beijingTime(context.now);
	let status: "approved" | "rejected" | "failed";
	let line: string;
	if (choiceText === "x") {
		status = "rejected";
		line = `❌ 已选择不处理（北京时间 ${clock}）`;
	} else {
		const loadHandler = handlers[row.kind];
		try {
			if (!loadHandler)
				throw new DomainError("owner_action_unknown_kind", 409, row.kind);
			const handler = await loadHandler();
			line = `${await handler(context, JSON.parse(row.payload), Number(choiceText))}（北京时间 ${clock}）`;
			status = "approved";
		} catch (error) {
			status = "failed";
			line = `⚠️ 没有执行：${failureReason(error)}。请到后台处理。（北京时间 ${clock}）`;
		}
	}
	await context.db
		.prepare(
			`UPDATE owner_action_requests SET status = ?, result = ?, updated_at = ?
			 WHERE id = ? AND status = 'processing'`,
		)
		.bind(status, line, context.now, id)
		.run();
	await callTelegram(
		credentials,
		"editMessageText",
		{
			chat_id: chatId,
			message_id: callback.message.message_id,
			text: `${row.message_text}\n\n${line}`,
			link_preview_options: { is_disabled: true },
			reply_markup: { inline_keyboard: [] },
		},
		request,
		"telegram_alert_delivery_failed",
	).catch(() => undefined);
	await answer(
		status === "approved"
			? "已完成"
			: status === "rejected"
				? "已忽略"
				: "失败",
	);
	return { handled: true as const, status };
}

async function isChatCreator(
	credentials: TelegramOwnerAlertCredentials,
	userId: number,
	request: Fetcher,
) {
	const member = await callTelegram(
		credentials,
		"getChatMember",
		{ chat_id: credentials.chatId, user_id: userId },
		request,
		"telegram_alert_chat_unavailable",
	).catch(() => null);
	return (
		z.object({ status: z.string() }).safeParse(member).data?.status ===
		"creator"
	);
}

function failureReason(error: unknown) {
	if (error instanceof DomainError) return error.message;
	return "内部错误";
}

function beijingTime(now: number) {
	const clock = beijingClock(now);
	const minute = String(new Date(now).getUTCMinutes()).padStart(2, "0");
	return `${clock.day.slice(5)} ${String(clock.hour).padStart(2, "0")}:${minute}`;
}

// ---- Webhook for the owner-alert bot ----

export async function ownerWebhookSecret(
	db: D1Database,
	credentials: TelegramOwnerAlertCredentials,
) {
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.integrationConfigSecret) return null;
	return hmacHex(
		runtime.integrationConfigSecret,
		`owner-alert-webhook:v1:${credentials.botToken.split(":")[0]}`,
	);
}

export class OwnerWebhookError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code);
	}
}

const updateSchema = z.looseObject({
	update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	callback_query: z.unknown().optional(),
});

export async function processOwnerAlertWebhook(
	context: OwnerActionContext & { fetcher?: Fetcher },
	body: string,
	providedSecret: string,
) {
	const credentials = await resolveTelegramOwnerAlertCredentials(context.db);
	const expected = credentials
		? await ownerWebhookSecret(context.db, credentials)
		: null;
	if (!credentials || !expected) return { accepted: false, inactive: true };
	if (!constantTimeStringEqual(providedSecret, expected))
		throw new OwnerWebhookError("invalid_secret", 401);
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		throw new OwnerWebhookError("invalid_json", 400);
	}
	const update = updateSchema.safeParse(value);
	if (!update.success) throw new OwnerWebhookError("invalid_update", 400);
	const reserved = await context.db
		.prepare(
			`INSERT INTO replay_receipts
			 (id, namespace, scope_id, external_id, event_type, payload_digest,
			  status, created_at, updated_at)
			 VALUES (?, 'telegram_owner_update', ?, ?, 'update', ?, 'processed', ?, ?)
			 ON CONFLICT(namespace, scope_id, external_id) DO NOTHING`,
		)
		.bind(
			crypto.randomUUID(),
			credentials.botToken.split(":")[0],
			String(update.data.update_id),
			await sha256Hex(body),
			context.now,
			context.now,
		)
		.run();
	if (Number(reserved.meta.changes ?? 0) !== 1)
		return { accepted: true, duplicate: true };
	if (update.data.callback_query)
		try {
			await handleOwnerActionCallback(context, update.data.callback_query);
		} catch (error) {
			// Let Telegram's retry reach us again instead of being dropped as a replay.
			await context.db
				.prepare(
					`DELETE FROM replay_receipts WHERE namespace = 'telegram_owner_update'
					 AND scope_id = ? AND external_id = ?`,
				)
				.bind(credentials.botToken.split(":")[0], String(update.data.update_id))
				.run();
			throw error;
		}
	return { accepted: true };
}

/**
 * Registers the button webhook once per bot token and origin. It never
 * replaces a webhook that points somewhere else, and refuses a bot shared
 * with the support bot (its webhook already belongs to the support flow).
 */
export async function ensureOwnerAlertWebhook(
	db: D1Database,
	options: { fetcher?: Fetcher; now?: number } = {},
) {
	const request = options.fetcher ?? fetch;
	const now = options.now ?? Date.now();
	const credentials = await resolveTelegramOwnerAlertCredentials(db);
	if (!credentials) return { status: "disabled" as const };
	const { runtime, provider } = await telegramRuntime(db);
	const secret = await ownerWebhookSecret(db, credentials);
	if (!secret) return { status: "secret_unavailable" as const };
	if (!URL.canParse(runtime.betterAuthUrl))
		return { status: "origin_unavailable" as const };
	const url = `${new URL(runtime.betterAuthUrl).origin}${ownerWebhookPath}`;
	const fingerprint = await sha256Hex(
		`${credentials.botToken}\0${url}\0${secret}`,
	);
	const stored = await db
		.prepare("SELECT value FROM system_settings WHERE key = ?")
		.bind(telegramOwnerAlertSettingKeys.webhookFingerprint)
		.first<{ value: string }>();
	if (stored && JSON.parse(stored.value) === fingerprint)
		return { status: "ready" as const };
	const blocked = await db
		.prepare("SELECT value, updated_at FROM system_settings WHERE key = ?")
		.bind(telegramOwnerAlertSettingKeys.webhookErrorCode)
		.first<{ value: string; updated_at: number }>();
	if (blocked && blocked.updated_at > now - webhookRetryMs)
		return { status: "blocked" as const, code: JSON.parse(blocked.value) };
	const fail = async (code: string) => {
		await db.batch([
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.webhookErrorCode,
				code,
				now,
			),
			db
				.prepare("DELETE FROM system_settings WHERE key = ?")
				.bind(telegramOwnerAlertSettingKeys.webhookFingerprint),
		]);
		return { status: "blocked" as const, code };
	};
	if (provider?.telegramBotToken === credentials.botToken)
		return fail("owner_webhook_shared_bot");
	const info = z
		.object({ url: z.string() })
		.safeParse(
			await callTelegram(
				credentials,
				"getWebhookInfo",
				{},
				request,
				"telegram_owner_webhook_failed",
			),
		);
	if (!info.success) return fail("owner_webhook_info_invalid");
	if (info.data.url && info.data.url !== url)
		return fail("owner_webhook_conflict");
	await callTelegram(
		credentials,
		"setWebhook",
		{
			url,
			secret_token: secret,
			allowed_updates: ["callback_query"],
		},
		request,
		"telegram_owner_webhook_failed",
	);
	await db.batch([
		upsertFeishuAlertSetting(
			db,
			telegramOwnerAlertSettingKeys.webhookFingerprint,
			fingerprint,
			now,
		),
		db
			.prepare("DELETE FROM system_settings WHERE key = ?")
			.bind(telegramOwnerAlertSettingKeys.webhookErrorCode),
	]);
	return { status: "registered" as const };
}

async function ownerWebhookReady(db: D1Database) {
	const row = await db
		.prepare("SELECT 1 FROM system_settings WHERE key = ?")
		.bind(telegramOwnerAlertSettingKeys.webhookFingerprint)
		.first();
	return row !== null;
}

async function hmacHex(key: string, value: string) {
	const imported = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return toHex(
		await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value)),
	);
}

async function sha256Hex(value: string) {
	return toHex(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
}

function toHex(buffer: ArrayBuffer) {
	return Array.from(new Uint8Array(buffer), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
