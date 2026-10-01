import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grammy from "grammy";
import {
	authProviderSettingKeys,
	telegramBotTokenSecretPurpose,
} from "../../src/features/auth/provider-settings";
import { encryptSecret } from "../../src/lib/secrets";
import { runWithRuntimeEnv } from "../../src/server/runtime/context";
import { openNodeDatabase } from "../../src/server/runtime/node/database";
import { applyNodeMigrations } from "../../src/server/runtime/node/migrations";
import { NodeObjectStorage } from "../../src/server/runtime/node/object-storage";

const supportChatId = "-1001234567890";
const secret = "synthetic-support-away-encryption-secret";
let revision = 100;
let database: ReturnType<typeof openNodeDatabase>;
let db: D1Database;
let sent: Array<{
	method: string;
	chat_id?: string | number;
	text?: string;
	message_thread_id?: number;
}>;
let admin: boolean;
let uncertainAway: boolean;
function transport(api: grammy.Api) {
	api.config.use((async (_previous, method, raw) => {
		const payload = raw as Record<string, unknown>;
		if (method === "getMe")
			return {
				ok: true,
				result: {
					id: 777777,
					is_bot: true,
					first_name: "Fixture",
					username: "fixture_bot",
				},
			};
		if (method === "getChatMember")
			return {
				ok: true,
				result: {
					status: admin ? "creator" : "member",
					user: { id: payload.user_id, is_bot: false, first_name: "Staff" },
					is_anonymous: false,
				},
			};
		if (["sendMessage", "forwardMessage", "sendDocument"].includes(method)) {
			sent.push({ method, ...payload });
			if (
				uncertainAway &&
				method === "sendMessage" &&
				String(payload.text).startsWith("老板，我这会儿不在")
			)
				throw Error("Synthetic uncertain send");
			return {
				ok: true,
				result: {
					message_id: sent.length,
					date: 1,
					chat: { id: Number(payload.chat_id), type: "supergroup" },
				},
			};
		}
		throw Error(`Unexpected Telegram method ${method}`);
	}) as Parameters<grammy.Api["config"]["use"]>[0]);
}
class TestApi extends grammy.Api {
	constructor(token: string) {
		super(token);
		transport(this);
	}
}
class TestBot extends grammy.Bot {
	constructor(token: string) {
		super(token);
		transport(this.api);
	}
}
mock.module("grammy", () => ({ ...grammy, Api: TestApi, Bot: TestBot }));
const { handleTelegramUpdate } = await import(
	"../../src/features/telegram/server/bot"
);
const { sendWebSupportMessage, currentWebSupportConversation } = await import(
	"../../src/features/telegram/server/web-support"
);
const cid = "00000000-0000-4000-8000-000000000003";
const session = "synthetic-customer-session";
function run<T>(task: () => T) {
	return runWithRuntimeEnv({ runtime: "bun", DB: database }, task);
}
function customerRequest() {
	return new Request("https://laoshirenvip.com/api/support/web?version=2", {
		headers: { cookie: `gmshop_web_support=${session}` },
	});
}

async function setting(key: string, value: unknown, sensitive = false) {
	await db
		.prepare(
			"INSERT OR REPLACE INTO system_settings (key,value,is_secret,created_at,updated_at) VALUES (?,?,?,1,1)",
		)
		.bind(key, JSON.stringify(value), sensitive ? 1 : 0)
		.run();
}

beforeEach(async () => {
	database = openNodeDatabase(":memory:");
	db = database as unknown as D1Database;
	await applyNodeMigrations(database);
	revision++;
	sent = [];
	admin = true;
	uncertainAway = false;
	await setting("runtime.data_encryption_secret", secret);
	await setting("runtime.better_auth_url", "https://laoshirenvip.com");
	await setting(authProviderSettingKeys.providers, [
		{
			id: "00000000-0000-4000-8000-000000000002",
			providerId: "telegram",
			providerType: "social",
			displayName: "Test",
			icon: null,
			clientId: null,
			scopes: [],
			allowSignup: false,
			enabled: true,
			sortOrder: 10,
		},
	]);
	await setting(authProviderSettingKeys.revision, revision);
	await setting(authProviderSettingKeys.telegramBotUserId, "777777");
	await setting(authProviderSettingKeys.telegramUsername, "fixture_bot");
	await setting(
		authProviderSettingKeys.telegramBotToken,
		await encryptSecret(
			"777777:synthetic_token_not_for_network",
			secret,
			telegramBotTokenSecretPurpose(),
		),
		true,
	);
	await setting("telegram.bot.status", "active");
	await setting("telegram.bot.synced_auth_revision", revision);
	await setting("telegram.support.chat_id", supportChatId);
	await setting("telegram.support.enabled", true);
	await setting("telegram.support.web_enabled", true);
	const sessionHash = Buffer.from(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(session)),
	).toString("base64url");
	await db
		.prepare(`INSERT INTO telegram_web_support_conversations
      (id,support_chat_id,visitor_id,email_encrypted,email_hash,session_token_hash,public_key_jwk,
       message_thread_id,status,next_reply_sequence,locale,created_at,updated_at)
      VALUES (?,?,'fixture','encrypted-fixture','fixture',?,'{}',99,'active',1,'zh-CN',1,1)`)
		.bind(cid, supportChatId, sessionHash)
		.run();
});

afterEach(() => {
	database.sqlite.close();
});

async function command(text: string, chatId = supportChatId, userId = 42) {
	return run(() =>
		handleTelegramUpdate(db, {
			update_id: revision,
			message: {
				message_id: revision,
				date: 1,
				chat: {
					id: Number(chatId),
					type: "supergroup",
					title: "Fixture support",
					is_forum: true,
				},
				from: {
					id: userId,
					is_bot: false,
					first_name: "Staff",
					language_code: "zh",
				},
				text,
				entities: [{ type: "bot_command", offset: 0, length: 5 }],
			},
		}),
	);
}

test("support owner can check that away replies are off by default", async () => {
	await command("/away status");
	expect(sent).toHaveLength(1);
	expect(String(sent[0]?.chat_id)).toBe(supportChatId);
	expect(sent[0]?.text).toContain("已关闭");
});

test("enabling requires a real buying-guide link, not a placeholder", async () => {
	await command("/away on");
	expect(sent.at(-1)?.text).toContain("先设置");
	await command("/away status");
	expect(sent.at(-1)?.text).toContain("已关闭");
});

test("owner configures a guide, enables and disables replies through the support command", async () => {
	await command("/away guide https://laoshirenvip.com/guide");
	await command("/away on");
	expect(sent.at(-1)?.text).toContain("已开启");
	expect(sent.at(-1)?.text).toContain("https://laoshirenvip.com/guide");
	await command("/away off");
	expect(sent.at(-1)?.text).toContain("已关闭");
});

test("web customer receives the approved away text and guide in their own conversation", async () => {
	await command("/away guide https://laoshirenvip.com/guide");
	await command("/away on");
	await run(() =>
		sendWebSupportMessage(db, customerRequest(), {
			clientMessageId: crypto.randomUUID(),
			text: "不知道怎么选购",
			locale: "zh-CN",
		}),
	);
	const response = await run(() =>
		currentWebSupportConversation(db, customerRequest(), 0),
	);
	expect(response.replies).toHaveLength(1);
	expect(response.replies[0]).toMatchObject({
		text: "老板，我这会儿不在，有问题先留言哈\n不知道怎么选购的，请看我们的选购指南\nhttps://laoshirenvip.com/guide\n消息看到了都会回复，回复后也会发邮件提醒你",
	});
	expect(
		sent.some(
			(item) =>
				item.message_thread_id === 99 &&
				item.text?.includes("老板，我这会儿不在"),
		),
	).toBe(true);
});

async function seedTelegramCustomer() {
	await db
		.prepare(
			"INSERT INTO users (id,name,email,preferred_locale,enabled) VALUES ('fixture-user','Customer','fixture@example.test','zh-CN',1)",
		)
		.run();
	await db
		.prepare(
			"INSERT INTO accounts (id,user_id,account_id,provider_id) VALUES ('fixture-account','fixture-user','54321','telegram')",
		)
		.run();
	await db
		.prepare(`INSERT INTO telegram_support_conversations
      (id,support_chat_id,telegram_user_id,customer_chat_id,user_id,topic_name,message_thread_id,status,created_at,updated_at,last_activity_at)
      VALUES ('fixture-tg',?,'54321','54321','fixture-user','Fixture customer',100,'active',1,1,1)`)
		.bind(supportChatId)
		.run();
}

test("Telegram support customer receives the same guide without an email promise", async () => {
	await seedTelegramCustomer();
	await command("/away guide https://laoshirenvip.com/guide");
	await command("/away on");
	await run(() =>
		handleTelegramUpdate(db, {
			update_id: revision + 10,
			message: {
				message_id: 50,
				date: Math.floor(Date.now() / 1000),
				chat: { id: 54321, type: "private" },
				from: {
					id: 54321,
					is_bot: false,
					first_name: "Customer",
					language_code: "zh",
				},
				text: "请问怎么选购",
			},
		}),
	);
	const reply = sent.find(
		(item) => String(item.chat_id) === "54321" && item.method === "sendMessage",
	);
	expect(reply?.text).toBe(
		"老板，我这会儿不在，有问题先留言哈\n不知道怎么选购的，请看我们的选购指南\nhttps://laoshirenvip.com/guide\n消息看到了都会回复",
	);
	expect(
		sent.some(
			(item) =>
				item.method === "forwardMessage" &&
				String(item.chat_id) === supportChatId,
		),
	).toBe(true);
});

test("away acknowledgement does not qualify as a human reply for manual email", async () => {
	await command("/away guide https://laoshirenvip.com/guide");
	await command("/away on");
	await run(() =>
		sendWebSupportMessage(db, customerRequest(), {
			clientMessageId: crypto.randomUUID(),
			text: "请稍后回复",
			locale: "zh-CN",
		}),
	);
	const { requestManualSupportEmail } = await import(
		"../../src/features/telegram/server/manual-support-email"
	);
	await expect(
		run(() =>
			requestManualSupportEmail(db, new TestApi("synthetic"), {
				chatId: supportChatId,
				userId: "42",
				threadId: 99,
				conversationId: cid,
			}),
		),
	).rejects.toMatchObject({ code: "support_reply_required" });
});

test("a customer's first file also receives exactly one away reply", async () => {
	const directory = await mkdtemp(join(tmpdir(), "support-away-"));
	try {
		await command("/away guide https://laoshirenvip.com/guide");
		await command("/away on");
		const body = new FormData();
		body.set("clientMessageId", crypto.randomUUID());
		body.set("locale", "zh-CN");
		body.set("file", new File(["fixture question"], "question.txt"));
		const request = new Request(
			"https://laoshirenvip.com/api/support/web/attachments",
			{
				method: "POST",
				body,
				headers: {
					cookie: `gmshop_web_support=${session}`,
					origin: "https://laoshirenvip.com",
				},
			},
		);
		const { uploadWebSupportAttachment } = await import(
			"../../src/features/telegram/server/web-support-attachments"
		);
		await runWithRuntimeEnv(
			{ runtime: "bun", DB: database, FILES: new NodeObjectStorage(directory) },
			() => uploadWebSupportAttachment(db, request),
		);
		const response = await run(() =>
			currentWebSupportConversation(db, customerRequest(), 0),
		);
		expect(response.replies).toHaveLength(1);
		expect(response.replies[0]).toMatchObject({
			text: expect.stringContaining("有问题先留言哈"),
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("concurrent customer messages get one acknowledgement per activation, off stops new replies", async () => {
	await command("/away guide https://laoshirenvip.com/guide");
	await command("/away on");
	const send = () =>
		run(() =>
			sendWebSupportMessage(db, customerRequest(), {
				clientMessageId: crypto.randomUUID(),
				text: "请问选购",
				locale: "zh-CN",
			}),
		);
	await Promise.all([send(), send(), send()]);
	await command("/away on");
	await send();
	expect(
		(await run(() => currentWebSupportConversation(db, customerRequest(), 0)))
			.replies,
	).toHaveLength(1);
	await command("/away off");
	await send();
	expect(
		(await run(() => currentWebSupportConversation(db, customerRequest(), 0)))
			.replies,
	).toHaveLength(1);
	await command("/away on");
	await send();
	expect(
		(await run(() => currentWebSupportConversation(db, customerRequest(), 0)))
			.replies,
	).toHaveLength(2);
});

test("disabled mode preserves normal customer delivery without an away reply", async () => {
	await run(() =>
		sendWebSupportMessage(db, customerRequest(), {
			clientMessageId: crypto.randomUUID(),
			text: "问题",
		}),
	);
	expect(
		(await run(() => currentWebSupportConversation(db, customerRequest(), 0)))
			.replies,
	).toHaveLength(0);
	expect(sent.some((item) => item.text === "💬 问题")).toBe(true);
});

test("wrong groups, personal chats and non-admins cannot change away mode", async () => {
	await command("/away guide https://laoshirenvip.com/guide", "-1009999999999");
	await command("/away on", "42");
	admin = false;
	await command("/away guide https://laoshirenvip.com/guide");
	expect(sent).toHaveLength(0);
});

test("external, credential-bearing, HTTP and malformed guide URLs cannot enable replies", async () => {
	for (const url of [
		"https://evil.test/guide",
		"http://laoshirenvip.com/guide",
		"https://user:pass@laoshirenvip.com/guide",
		"https://laoshirenvip.com:123/guide",
		"not-a-link",
	]) {
		await command(`/away guide ${url}`);
		expect(sent.at(-1)?.text).toContain("未保存");
	}
	await command("/away on");
	expect(sent.at(-1)?.text).toContain("先设置");
});

test("uncertain mirror delivery neither fails the customer send nor repeats the away reply", async () => {
	await command("/away guide https://laoshirenvip.com/guide");
	await command("/away on");
	uncertainAway = true;
	const send = () =>
		run(() =>
			sendWebSupportMessage(db, customerRequest(), {
				clientMessageId: crypto.randomUUID(),
				text: "问题",
			}),
		);
	expect(await send()).toMatchObject({ sent: true });
	expect(await send()).toMatchObject({ sent: true });
	expect(
		(await run(() => currentWebSupportConversation(db, customerRequest(), 0)))
			.replies,
	).toHaveLength(1);
	expect(
		sent.filter((item) => item.text?.startsWith("老板，我这会儿不在")),
	).toHaveLength(1);
});

test("website language chooses the away text rather than the staff's language", async () => {
	await command("/away guide https://laoshirenvip.com/guide");
	await command("/away on");
	await run(() =>
		sendWebSupportMessage(db, customerRequest(), {
			clientMessageId: crypto.randomUUID(),
			text: "Help",
			locale: "en-US",
		}),
	);
	const response = await run(() =>
		currentWebSupportConversation(db, customerRequest(), 0),
	);
	expect(response.replies[0]).toMatchObject({
		text: expect.stringContaining("I’m away right now"),
	});
});

test("delayed Telegram updates from before activation are not auto-acknowledged", async () => {
	await seedTelegramCustomer();
	await command("/away guide https://laoshirenvip.com/guide");
	await command("/away on");
	await run(() =>
		handleTelegramUpdate(db, {
			update_id: revision + 50,
			message: {
				message_id: 50,
				date: 1,
				chat: { id: 54321, type: "private" },
				from: { id: 54321, is_bot: false, first_name: "Customer" },
				text: "旧消息",
			},
		}),
	);
	expect(
		sent.filter(
			(item) =>
				String(item.chat_id) === "54321" && item.method === "sendMessage",
		),
	).toHaveLength(0);
});
