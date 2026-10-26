import { z } from "zod";
import { beijingClock } from "#/features/ops-automation/server/shared";
import { DomainError } from "#/lib/domain-error";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { upsertFeishuAlertSetting } from "./feishu-alerts";
import {
	callTelegram,
	type OwnerAlertTopic,
	ownerAlertThreadId,
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
// Messages are only replies to input prompts (the bot runs in privacy mode).
const allowedUpdates = ["callback_query", "message"];
/** A claim older than this is presumed lost (crashed request) and may be retried. */
const processingLeaseMs = 5 * 60_000;

const callbackPattern = /^oa:([0-9a-f-]{36}):(\d|x)$/;

export type OwnerActionContext = {
	db: D1Database;
	cache: KVNamespace | undefined;
	now: number;
	/** Bearer token for lsrai.shop's internal reseller-program API. */
	agentProgramToken?: string;
	/** Telegram user id of the approver, set while a handler runs. */
	decidedBy?: string;
};

/** Returns the line appended to the message after a successful approval. */
type OwnerActionHandler = (
	context: OwnerActionContext,
	payload: unknown,
	choice: number,
	input?: string,
) => Promise<string>;

type HandlerEntry = {
	/** Forum topic the proposal is posted into. */
	topic: OwnerAlertTopic;
	// Loaded lazily: the handlers' modules import this one to send proposals.
	load: () => Promise<OwnerActionHandler>;
	/** Line shown when the owner presses the reject button. */
	rejectedLine?: string;
	/** Runs when the owner presses the reject button; failures are ignored. */
	loadReject?: () => Promise<
		(context: OwnerActionContext, payload: unknown) => Promise<void>
	>;
	/** A failure leaves the request pending so the same button can retry it. */
	retryOnFailure?: boolean;
	/** The approve button asks for one line of text, validated by `pattern`. */
	input?: {
		prompt: string;
		placeholder: string;
		pattern: RegExp;
		formatHint: string;
	};
};

const handlers: Record<string, HandlerEntry> = {
	supplier_rebind: {
		topic: "restock",
		load: async () =>
			(await import("#/features/suppliers/server/rebind-proposal"))
				.approveSupplierRebind,
	},
	supplier_cost_cap: {
		topic: "restock",
		load: async () =>
			(await import("#/features/suppliers/server/rebind-proposal"))
				.approveSupplierCostCap,
	},
	pricing_raise: {
		topic: "restock",
		load: async () =>
			(await import("#/features/ops-automation/server/pricing-guard"))
				.approvePricingRaise,
	},
	customer_price_set: {
		topic: "general",
		load: async () =>
			(await import("#/features/customer-pricing/server/telegram"))
				.approveCustomerPriceSet,
		rejectedLine: "❌ 已取消，没有设置",
	},
	customer_price_delete: {
		topic: "general",
		load: async () =>
			(await import("#/features/customer-pricing/server/telegram"))
				.approveCustomerPriceDelete,
		rejectedLine: "❌ 已取消，没有删除",
	},
	customer_price_raise: {
		topic: "restock",
		load: async () =>
			(await import("#/features/customer-pricing/server/telegram"))
				.approveCustomerPriceRaise,
		rejectedLine: "保持不变",
	},
	bulk_procurement: {
		topic: "restock",
		load: async () =>
			(await import("#/features/redeem-warehouse/server/bulk-procurement"))
				.approveBulkProcurement,
		rejectedLine: "🚫 这批不进了，客户兑换时单张进货",
	},
	agent_wallet_topup: {
		topic: "orders",
		load: async () =>
			(await import("#/features/agent-program/server/wallet-topup"))
				.approveWalletTopUp,
		rejectedLine: "❌ 已取消，没有充值",
		retryOnFailure: true,
	},
	supplier_topup_offer: {
		topic: "restock",
		load: async () =>
			(await import("#/features/supplier-topup/server/topup"))
				.approveSupplierTopUpOffer,
		rejectedLine: "🙅 不充值，这次提醒已关闭",
	},
	supplier_topup_paid: {
		topic: "restock",
		load: async () =>
			(await import("#/features/supplier-topup/server/topup"))
				.approveSupplierTopUpPaid,
		loadReject: async () =>
			(await import("#/features/supplier-topup/server/topup"))
				.rejectSupplierTopUpPaid,
		rejectedLine: "❌ 不充值了，这笔订单作废（没付款就不用管）",
	},
	agent_withdrawal_paid: {
		topic: "withdrawals",
		load: async () =>
			(await import("#/features/agent-program/server/withdrawal-alerts"))
				.markWithdrawalPaidFromTelegram,
		rejectedLine: "⏸ 先不处理，提现仍是待打款",
		input: {
			prompt: "请回复这条消息，填写这笔转账的支付宝订单号：",
			placeholder: "支付宝订单号",
			pattern: /^[0-9A-Za-z_-]{6,64}$/,
			formatHint: "支付宝订单号只能是 6–64 位数字或字母",
		},
	},
};

/** Replies with this text, or `null` when the command sent its own message. */
type OwnerCommand = (
	context: OwnerActionContext & { fetcher?: Fetcher },
	args: string,
) => Promise<string | null>;

// Owner commands typed in the owner-alert chat, e.g. "/topup a@b.com 300".
const commands: Record<
	string,
	{ description: string; load: () => Promise<OwnerCommand> }
> = {
	vip: {
		description: "客户专属价：/vip 邮箱",
		load: async () =>
			(await import("#/features/customer-pricing/server/telegram")).vipCommand,
	},
	vipprice: {
		description: "设置客户专属价：/vipprice 邮箱 商品 [N张起] 价格",
		load: async () =>
			(await import("#/features/customer-pricing/server/telegram"))
				.vipPriceCommand,
	},
	vipdel: {
		description: "删除客户专属价：/vipdel 邮箱 商品 [N张起]",
		load: async () =>
			(await import("#/features/customer-pricing/server/telegram"))
				.vipDeleteCommand,
	},
	topup: {
		description: "代理钱包充值：/topup 邮箱 金额",
		load: async () =>
			(await import("#/features/agent-program/server/wallet-topup"))
				.topUpCommand,
	},
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
		/** Appended to the plain alert without buttons; `null` sends nothing. */
		fallback: string | null;
		now: number;
		fetcher?: Fetcher;
		/** Defaults to `ownerActionTtlMs`. */
		ttlMs?: number;
	},
) {
	const request = input.fetcher ?? fetch;
	const credentials = await resolveTelegramOwnerAlertCredentials(db);
	if (!credentials || !(await ownerWebhookReady(db))) {
		if (input.fallback !== null)
			await sendOwnerAlert(db, `${input.text}\n\n${input.fallback}`, {
				fetcher: request,
				topic: handlers[input.kind]?.topic,
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
			input.now + (input.ttlMs ?? ownerActionTtlMs),
			input.now,
			input.now,
		)
		.run();
	const threadId = ownerAlertThreadId(credentials, handlers[input.kind]?.topic);
	const message = z.object({ message_id: z.number().int() }).parse(
		await callTelegram(
			credentials,
			"sendMessage",
			{
				chat_id: credentials.chatId,
				...(threadId ? { message_thread_id: threadId } : {}),
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
			// Set for messages inside a forum topic.
			message_thread_id: z.number().int().positive().optional(),
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
	prompt_message_id: number | null;
	prompt_choice: number | null;
};

const actionColumns = `id, kind, payload, message_text, status, chat_id,
	message_id, prompt_message_id, prompt_choice`;

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
	const [, id = "", choiceText] = match;
	const chatId = String(callback.message.chat.id);
	if (chatId !== credentials.chatId || callback.from.is_bot) {
		await answer("无权限");
		return { handled: true as const, status: "forbidden" };
	}
	if (!(await isChatCreator(credentials, callback.from.id, request))) {
		await answer("只有群主可以操作");
		return { handled: true as const, status: "forbidden" };
	}
	const row = await context.db
		.prepare(
			`SELECT ${actionColumns} FROM owner_action_requests
			 WHERE id = ? AND status = 'pending' AND expires_at > ?
			  AND chat_id = ? AND message_id = ?`,
		)
		.bind(id, context.now, chatId, callback.message.message_id)
		.first<ActionRow>();
	const input = row && choiceText !== "x" ? handlers[row.kind]?.input : null;
	if (row && input) {
		// Ask for the text first; the reply to this prompt runs the action.
		const prompt = z.object({ message_id: z.number().int() }).safeParse(
			await callTelegram(
				credentials,
				"sendMessage",
				{
					chat_id: chatId,
					...threadField(callback.message.message_thread_id),
					text: input.prompt,
					reply_parameters: { message_id: callback.message.message_id },
					reply_markup: {
						force_reply: true,
						selective: true,
						input_field_placeholder: input.placeholder,
					},
				},
				request,
				"telegram_alert_delivery_failed",
			).catch(() => null),
		);
		if (!prompt.success) {
			await answer("发送失败，请再点一次");
			return { handled: true as const, status: "failed" };
		}
		await context.db
			.prepare(
				`UPDATE owner_action_requests SET prompt_message_id = ?,
				 prompt_choice = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
			)
			.bind(prompt.data.message_id, Number(choiceText), context.now, id)
			.run();
		await answer("请回复上面的提示");
		return { handled: true as const, status: "awaiting_input" };
	}
	const result = await claimAndRun(context, credentials, {
		id,
		chatId,
		messageId: callback.message.message_id,
		decidedBy: String(callback.from.id),
		choice: choiceText === "x" ? null : Number(choiceText),
	});
	await answer(
		result.status === "approved"
			? "已完成"
			: result.status === "rejected"
				? "已忽略"
				: result.status === "stale"
					? "这条已经处理过或已过期"
					: result.line.slice(0, 190) || "失败",
	);
	return { handled: true as const, status: result.status };
}

const replyMessageSchema = z.object({
	message_id: z.number().int(),
	// Set for messages inside a forum topic; the chat id is the supergroup's.
	message_thread_id: z.number().int().positive().optional(),
	chat: z.object({ id: z.number().int() }),
	from: z.object({ id: z.number().int(), is_bot: z.boolean().optional() }),
	text: z.string().optional(),
	reply_to_message: z.object({ message_id: z.number().int() }).optional(),
});

const commandPattern = /^\/([a-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/;

/** A slash command from the chat creator in the owner-alert chat. */
export async function handleOwnerCommand(
	context: OwnerActionContext & { fetcher?: Fetcher },
	rawMessage: unknown,
) {
	const request = context.fetcher ?? fetch;
	const parsed = replyMessageSchema.safeParse(rawMessage);
	const credentials = await resolveTelegramOwnerAlertCredentials(context.db);
	if (!parsed.success || !credentials) return { handled: false as const };
	const message = parsed.data;
	const match = commandPattern.exec((message.text ?? "").trim());
	const command = match ? commands[match[1] ?? ""] : undefined;
	if (
		!match ||
		!command ||
		String(message.chat.id) !== credentials.chatId ||
		message.from.is_bot
	)
		return { handled: false as const };
	const say = (text: string) =>
		callTelegram(
			credentials,
			"sendMessage",
			{
				chat_id: credentials.chatId,
				...threadField(message.message_thread_id),
				text,
				reply_parameters: { message_id: message.message_id },
			},
			request,
			"telegram_alert_delivery_failed",
		).catch(() => undefined);
	if (!(await isChatCreator(credentials, message.from.id, request))) {
		await say("只有群主可以操作");
		return { handled: true as const, status: "forbidden" };
	}
	const run = await command.load();
	const reply = await run(
		{ ...context, decidedBy: String(message.from.id) },
		(match[2] ?? "").trim(),
	).catch((error) => `⚠️ ${failureReason(error)}`);
	if (reply) await say(reply);
	return { handled: true as const, status: "ran" };
}

/** A reply to an input prompt from the chat creator completes that action. */
export async function handleOwnerActionReply(
	context: OwnerActionContext & { fetcher?: Fetcher },
	rawMessage: unknown,
) {
	const request = context.fetcher ?? fetch;
	const parsed = replyMessageSchema.safeParse(rawMessage);
	const credentials = await resolveTelegramOwnerAlertCredentials(context.db);
	if (!parsed.success || !credentials || !parsed.data.reply_to_message)
		return { handled: false as const };
	const message = parsed.data;
	const chatId = String(message.chat.id);
	if (chatId !== credentials.chatId || message.from.is_bot)
		return { handled: false as const };
	const row = await context.db
		.prepare(
			`SELECT ${actionColumns} FROM owner_action_requests
			 WHERE chat_id = ? AND prompt_message_id = ? AND status = 'pending'
			  AND expires_at > ?`,
		)
		.bind(chatId, message.reply_to_message?.message_id, context.now)
		.first<ActionRow>();
	const input = row ? handlers[row.kind]?.input : null;
	if (!row || !input || row.prompt_choice === null || !row.message_id)
		return { handled: false as const };
	const say = (text: string) =>
		callTelegram(
			credentials,
			"sendMessage",
			{
				chat_id: chatId,
				...threadField(message.message_thread_id),
				text,
				reply_parameters: { message_id: message.message_id },
			},
			request,
			"telegram_alert_delivery_failed",
		).catch(() => undefined);
	if (!(await isChatCreator(credentials, message.from.id, request))) {
		await say("只有群主可以操作");
		return { handled: true as const, status: "forbidden" };
	}
	const text = (message.text ?? "").trim();
	if (!input.pattern.test(text)) {
		await say(`格式不对：${input.formatHint}。请重新回复上面的提示。`);
		return { handled: true as const, status: "invalid_input" };
	}
	const result = await claimAndRun(context, credentials, {
		id: row.id,
		chatId,
		messageId: row.message_id,
		decidedBy: String(message.from.id),
		choice: row.prompt_choice,
		input: text,
	});
	await say(
		result.status === "approved"
			? "已完成"
			: result.status === "stale"
				? "这条已经处理过或已过期"
				: result.line,
	);
	return { handled: true as const, status: result.status };
}

/** Claims the request once, runs it, records the result and edits the message. */
async function claimAndRun(
	context: OwnerActionContext & { fetcher?: Fetcher },
	credentials: TelegramOwnerAlertCredentials,
	input: {
		id: string;
		chatId: string;
		messageId: number;
		decidedBy: string;
		choice: number | null;
		input?: string;
	},
) {
	const request = context.fetcher ?? fetch;
	const claimed = await context.db
		.prepare(
			`UPDATE owner_action_requests SET status = 'processing',
			 decided_by = ?, decided_at = ?, updated_at = ?
			 WHERE id = ? AND expires_at > ? AND chat_id = ? AND message_id = ?
			  AND (status = 'pending' OR (status = 'processing' AND decided_at < ?))`,
		)
		.bind(
			input.decidedBy,
			context.now,
			context.now,
			input.id,
			context.now,
			input.chatId,
			input.messageId,
			context.now - processingLeaseMs,
		)
		.run();
	const row = await context.db
		.prepare(`SELECT ${actionColumns} FROM owner_action_requests WHERE id = ?`)
		.bind(input.id)
		.first<ActionRow>();
	if (Number(claimed.meta.changes ?? 0) !== 1 || !row)
		return { status: "stale" as const, line: "" };
	const clock = beijingTime(context.now);
	let status: "approved" | "rejected" | "failed";
	let line: string;
	if (input.choice === null) {
		const reject = await handlers[row.kind]?.loadReject?.();
		await reject?.(context, JSON.parse(row.payload)).catch(() => undefined);
		status = "rejected";
		line = `${handlers[row.kind]?.rejectedLine ?? "❌ 已选择不处理"}（北京时间 ${clock}）`;
	} else {
		const entry = handlers[row.kind];
		try {
			if (!entry)
				throw new DomainError("owner_action_unknown_kind", 409, row.kind);
			const handler = await entry.load();
			line = `${await handler(
				{ ...context, decidedBy: input.decidedBy },
				JSON.parse(row.payload),
				input.choice,
				input.input,
			)}（北京时间 ${clock}）`;
			status = "approved";
		} catch (error) {
			status = "failed";
			line = `⚠️ 没有执行：${failureReason(error)}。请到后台处理。（北京时间 ${clock}）`;
		}
	}
	if (status === "failed" && handlers[row.kind]?.retryOnFailure) {
		await context.db
			.prepare(
				`UPDATE owner_action_requests SET status = 'pending', result = ?,
				 decided_by = NULL, decided_at = NULL, updated_at = ?
				 WHERE id = ? AND status = 'processing'`,
			)
			.bind(line, context.now, input.id)
			.run();
		return { status, line };
	}
	await context.db
		.prepare(
			`UPDATE owner_action_requests SET status = ?, result = ?, updated_at = ?
			 WHERE id = ? AND status = 'processing'`,
		)
		.bind(status, line, context.now, input.id)
		.run();
	await callTelegram(
		credentials,
		"editMessageText",
		{
			chat_id: input.chatId,
			message_id: input.messageId,
			text: `${row.message_text}\n\n${line}`,
			link_preview_options: { is_disabled: true },
			reply_markup: { inline_keyboard: [] },
		},
		request,
		"telegram_alert_delivery_failed",
	).catch(() => undefined);
	return { status, line };
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

/** Replies stay in the topic of the incoming message. */
function threadField(threadId: number | undefined) {
	return threadId ? { message_thread_id: threadId } : {};
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
	message: z.unknown().optional(),
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
	if (update.data.callback_query || update.data.message)
		try {
			if (update.data.callback_query)
				await handleOwnerActionCallback(context, update.data.callback_query);
			else if (
				!(await handleOwnerCommand(context, update.data.message)).handled
			)
				await handleOwnerActionReply(context, update.data.message);
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
		`${credentials.botToken}\0${url}\0${secret}\0${allowedUpdates.join(",")}\0${Object.keys(commands).join(",")}`,
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
		"setMyCommands",
		{
			scope: { type: "chat", chat_id: credentials.chatId },
			commands: Object.entries(commands).map(([command, entry]) => ({
				command,
				description: entry.description,
			})),
		},
		request,
		"telegram_owner_webhook_failed",
	);
	await callTelegram(
		credentials,
		"setWebhook",
		{
			url,
			secret_token: secret,
			allowed_updates: allowedUpdates,
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
