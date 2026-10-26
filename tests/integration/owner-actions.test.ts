import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithdrawalAlerts } from "#/features/agent-program/server/withdrawal-alerts";
import { createSupplierCredentialVault } from "#/features/suppliers/secrets";
import { syncSupplierSource } from "#/features/suppliers/server/source-sync";
import { upsertFeishuAlertSetting } from "#/features/telegram/server/feishu-alerts";
import {
	ensureOwnerAlertWebhook,
	ownerWebhookSecret,
	processOwnerAlertWebhook,
} from "#/features/telegram/server/owner-actions";
import {
	encryptTelegramOwnerAlertBotToken,
	resolveTelegramOwnerAlertCredentials,
	telegramOwnerAlertSettingKeys,
} from "#/features/telegram/server/owner-alerts";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

const botToken = "1234567890:AAtest-only-owner-alert-token_abcdefgh";
const chatId = "-5101401750";
const ownerId = 42;
const memberId = 43;
const withdrawal = {
	id: 12,
	reseller_id: 5,
	label: "777 子站",
	amount: "88.00",
	currency: "CNY",
	account: "agent@alipay.example",
	email: "agent@example.com",
	status: "pending",
	created_at: "2026-10-19T01:00:00Z",
	alipay_trade_no: "",
	processed_operator: "",
};
const source = {
	provider: "dujiao_next" as const,
	normalizedApiOrigin: "https://supplier.example",
	protocolVersion: "1.3.1-upstream-v1",
};

type TelegramCall = { method: string; body: Record<string, unknown> };

describe("owner actions: switch a delisted supplier SKU from Telegram", {
	timeout: 30_000,
}, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let cache: KVNamespace;
	let telegram: TelegramCall[];
	let program: { path: string; body: unknown }[];
	let webhookNow: number;
	let topUpFailures: number;
	let webhookUrl: string;
	const runtime = createInitialRuntimeConfig("https://shop.example");

	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.host === "api.telegram.org") {
			const method = url.pathname.split("/").at(-1) ?? "";
			const body = JSON.parse(String(init?.body ?? "{}"));
			telegram.push({ method, body });
			if (method === "getWebhookInfo")
				return Response.json({ ok: true, result: { url: webhookUrl } });
			if (method === "getChatMember")
				return Response.json({
					ok: true,
					result: { status: body.user_id === ownerId ? "creator" : "member" },
				});
			if (method === "sendMessage")
				return Response.json({
					ok: true,
					result: {
						message_id:
							776 +
							telegram.filter((call) => call.method === "sendMessage").length,
					},
				});
			return Response.json({ ok: true, result: true });
		}
		if (url.host === "lsrai.shop") {
			program.push({
				path: url.pathname + url.search,
				body: init?.body ? JSON.parse(String(init.body)) : null,
			});
			if (url.pathname.endsWith("/wallet-topups/preview"))
				return Response.json({
					status_code: 0,
					data: {
						user_id: 7,
						email: "agent@example.com",
						partner_type: "reseller",
						balance: "530.00",
					},
				});
			if (url.pathname.endsWith("/wallet-topups")) {
				if (topUpFailures-- > 0)
					return new Response("bad gateway", { status: 502 });
				return Response.json({
					status_code: 0,
					data: {
						user_id: 7,
						email: "agent@example.com",
						partner_type: "reseller",
						balance: "830.00",
						transaction_id: 95,
						amount: "300.00",
						balance_before: "530.00",
						balance_after: "830.00",
						duplicate: false,
					},
				});
			}
			if (url.pathname.endsWith("/mark-paid"))
				return Response.json({
					status_code: 0,
					data: { id: 12, status: "paid" },
				});
			return Response.json({ status_code: 0, data: [withdrawal] });
		}
		if (url.pathname.endsWith("/categories"))
			return Response.json({ ok: true, categories: [] });
		return catalogResponse();
	};

	beforeEach(async () => {
		telegram = [];
		program = [];
		webhookNow = 1_800_011_000_000;
		topUpFailures = 0;
		webhookUrl = "";
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
			kvNamespaces: { CACHE: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		cache = (await miniflare.getKVNamespace("CACHE")) as unknown as KVNamespace;
		await applyMigrations(db);
		await db.batch([
			db
				.prepare(
					`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
					 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1),
					        ('runtime.better_auth_url', ?, 0, 1, 1)`,
				)
				.bind(
					JSON.stringify(runtime.dataEncryptionSecret),
					JSON.stringify("https://shop.example"),
				),
		]);
		await db.batch([
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.enabled,
				true,
				1,
			),
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.chatId,
				chatId,
				1,
			),
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.botToken,
				await encryptTelegramOwnerAlertBotToken(db, botToken),
				1,
				true,
			),
		]);
		await seedAccount(db, runtime.commerceSecret);
		await seedDelistedBinding(db);
	});

	afterEach(async () => miniflare.dispose());

	async function syncTwice() {
		for (const now of [1_800_010_000_000, 1_800_010_600_000])
			await syncSupplierSource({
				db,
				cache,
				runtime,
				source,
				trigger: "scheduled",
				now,
				fetcher,
			});
	}

	async function deliver(update: Record<string, unknown>) {
		const credentials = await resolveTelegramOwnerAlertCredentials(db);
		if (!credentials) throw new Error("telegram not configured");
		const secret = (await ownerWebhookSecret(db, credentials)) ?? "";
		return processOwnerAlertWebhook(
			{
				db,
				cache,
				now: webhookNow,
				fetcher,
				agentProgramToken: "program-token",
			},
			JSON.stringify(update),
			secret,
		);
	}

	function tap(fromId: number, data: string, updateId: number) {
		return deliver({
			update_id: updateId,
			callback_query: {
				id: `cb-${updateId}`,
				data,
				from: { id: fromId, is_bot: false },
				message: { message_id: 777, chat: { id: Number(chatId) } },
			},
		});
	}

	function reply(
		fromId: number,
		text: string,
		replyTo: number,
		updateId: number,
	) {
		return deliver({
			update_id: updateId,
			message: {
				message_id: 900 + updateId,
				chat: { id: Number(chatId) },
				from: { id: fromId, is_bot: false },
				text,
				reply_to_message: { message_id: replyTo },
			},
		});
	}

	async function bindingState() {
		return db
			.prepare(
				`SELECT sb.upstream_product_id, sb.max_cost_minor, psi.supplier_status
				 FROM supplier_bindings sb
				 JOIN product_sellable_items psi ON psi.id = sb.sellable_item_id
				 WHERE psi.id = 'gemini-item' AND sb.enabled = 1`,
			)
			.first();
	}

	it("registers the webhook once, then proposes and applies the switch on the owner's tap", async () => {
		await expect(ensureOwnerAlertWebhook(db, { fetcher })).resolves.toEqual({
			status: "registered",
		});
		await expect(ensureOwnerAlertWebhook(db, { fetcher })).resolves.toEqual({
			status: "ready",
		});
		expect(
			telegram.filter((call) => call.method === "setWebhook"),
		).toMatchObject([
			{
				body: {
					url: "https://shop.example/api/telegram/owner-webhook",
					allowed_updates: ["callback_query", "message"],
				},
			},
		]);

		await syncTwice();
		const proposal = telegram.find((call) => call.method === "sendMessage");
		expect(proposal?.body.text).toContain("Gemini Pro｜18个月");
		expect(proposal?.body.text).toContain("编号 1）进价 ¥1.00");
		const keyboard = (
			proposal?.body.reply_markup as {
				inline_keyboard: { text: string; callback_data: string }[][];
			}
		).inline_keyboard;
		expect(keyboard.map((row) => row[0]?.text)).toEqual([
			"✅ 换上游",
			"❌ 不换",
		]);
		expect(await bindingState()).toMatchObject({
			upstream_product_id: "9",
			supplier_status: "unavailable",
		});

		const approve = keyboard[0]?.[0]?.callback_data ?? "";
		await expect(tap(memberId, approve, 1)).resolves.toMatchObject({
			accepted: true,
		});
		expect(await bindingState()).toMatchObject({ upstream_product_id: "9" });

		await tap(ownerId, approve, 2);
		expect(await bindingState()).toEqual({
			upstream_product_id: "1",
			max_cost_minor: "150",
			supplier_status: "available",
		});
		const edit = telegram.find((call) => call.method === "editMessageText");
		expect(edit?.body.text).toContain("✅ 已换上游：编号 1");
		expect(edit?.body.reply_markup).toEqual({ inline_keyboard: [] });

		// A replayed update and a second tap both do nothing.
		await expect(tap(ownerId, approve, 2)).resolves.toMatchObject({
			duplicate: true,
		});
		await tap(ownerId, keyboard[1]?.[0]?.callback_data ?? "", 3);
		const rows = await db
			.prepare("SELECT status, decided_by FROM owner_action_requests")
			.all();
		expect(rows.results).toEqual([
			{ status: "approved", decided_by: String(ownerId) },
		]);
	});

	it("offers to resume at the new cost when the upstream price passes the cap", async () => {
		await db
			.prepare(
				`UPDATE supplier_bindings SET upstream_product_id = '1',
				 upstream_sku_id = '2', reference_cost_minor = '80',
				 max_cost_minor = '80' WHERE id = 'gemini-binding'`,
			)
			.run();
		await ensureOwnerAlertWebhook(db, { fetcher });
		await syncSupplierSource({
			db,
			cache,
			runtime,
			source,
			trigger: "scheduled",
			now: 1_800_010_000_000,
			fetcher,
		});
		const proposal = telegram.find((call) => call.method === "sendMessage");
		expect(proposal?.body.text).toContain("上游涨价，已自动停售");
		expect(proposal?.body.text).toContain("进价 ¥0.80 → ¥1.00，超过上限 ¥0.80");
		expect(proposal?.body.text).toContain("按新进价每单毛利 ¥9.00");
		const keyboard = (
			proposal?.body.reply_markup as {
				inline_keyboard: { text: string; callback_data: string }[][];
			}
		).inline_keyboard;
		expect(keyboard.map((row) => row[0]?.text)).toEqual([
			"✅ 按新进价恢复销售",
			"❌ 先不卖",
		]);
		expect(await bindingState()).toMatchObject({
			max_cost_minor: "80",
			supplier_status: "unavailable",
		});
		await tap(ownerId, keyboard[0]?.[0]?.callback_data ?? "", 10);
		expect(await bindingState()).toEqual({
			upstream_product_id: "1",
			max_cost_minor: "100",
			supplier_status: "available",
		});
		// The next sync keeps it on sale and does not ask again.
		await syncSupplierSource({
			db,
			cache,
			runtime,
			source,
			trigger: "scheduled",
			now: 1_800_010_600_000,
			fetcher,
		});
		expect(await bindingState()).toMatchObject({
			supplier_status: "available",
		});
		expect(
			telegram.filter((call) => call.method === "sendMessage"),
		).toHaveLength(1);
	});

	it("marks a withdrawal paid after the owner replies with the Alipay trade number", async () => {
		await ensureOwnerAlertWebhook(db, { fetcher });
		// 10:30 Beijing on 2026-10-19.
		const morning = Date.UTC(2026, 9, 19, 2, 30);
		webhookNow = morning + 60_000;
		const run = () =>
			runWithdrawalAlerts({
				db,
				token: "program-token",
				now: morning,
				fetcher,
			});
		await expect(run()).resolves.toEqual({
			status: "ran",
			pending: 1,
			proposed: 1,
		});
		await expect(run()).resolves.toEqual({ status: "done" });
		const proposal = telegram.find((call) => call.method === "sendMessage");
		expect(proposal?.body.text).toContain("💸 代理提现待打款 #12");
		expect(proposal?.body.text).toContain("支付宝账号：agent@alipay.example");
		const approve = (
			proposal?.body.reply_markup as {
				inline_keyboard: { callback_data: string }[][];
			}
		).inline_keyboard[0]?.[0]?.callback_data;

		await tap(ownerId, approve ?? "", 20);
		const prompt = telegram.filter((call) => call.method === "sendMessage")[1];
		expect(prompt?.body.reply_markup).toMatchObject({ force_reply: true });
		expect(program.some((call) => call.path.endsWith("/mark-paid"))).toBe(
			false,
		);

		await reply(memberId, "2026102022001488551234567890", 778, 21);
		await reply(ownerId, "坏", 778, 22);
		expect(program.some((call) => call.path.endsWith("/mark-paid"))).toBe(
			false,
		);

		await reply(ownerId, "2026102022001488551234567890", 778, 23);
		expect(program.find((call) => call.path.endsWith("/mark-paid"))).toEqual({
			path: "/api/internal/reseller-program/withdrawals/12/mark-paid",
			body: {
				alipay_trade_no: "2026102022001488551234567890",
				operator: `telegram:${ownerId}`,
			},
		});
		const edit = telegram.find((call) => call.method === "editMessageText");
		expect(edit?.body.text).toContain("✅ 已标记打款：¥88.00");
		await expect(
			db.prepare("SELECT status FROM owner_action_requests").first("status"),
		).resolves.toBe("approved");
	});

	it("posts proposals into their forum topic and replies in the incoming thread", async () => {
		await db.batch([
			upsertFeishuAlertSetting(
				db,
				telegramOwnerAlertSettingKeys.topics,
				{ orders: 5, withdrawals: 6, restock: 7 },
				1,
			),
		]);
		await ensureOwnerAlertWebhook(db, { fetcher });
		const morning = Date.UTC(2026, 9, 19, 2, 30);
		webhookNow = morning + 60_000;
		await runWithdrawalAlerts({
			db,
			token: "program-token",
			now: morning,
			fetcher,
		});
		const sent = () => telegram.filter((call) => call.method === "sendMessage");
		expect(sent()[0]?.body.message_thread_id).toBe(6);
		const approve = (
			sent()[0]?.body.reply_markup as {
				inline_keyboard: { callback_data: string }[][];
			}
		).inline_keyboard[0]?.[0]?.callback_data;

		// A tap inside the topic: the input prompt stays in that topic.
		await deliver({
			update_id: 40,
			callback_query: {
				id: "cb-40",
				data: approve,
				from: { id: ownerId, is_bot: false },
				message: {
					message_id: 777,
					message_thread_id: 6,
					chat: { id: Number(chatId) },
				},
			},
		});
		expect(sent()[1]?.body).toMatchObject({ message_thread_id: 6 });

		// A command typed in another topic gets its reply there; the
		// confirmation goes to the orders topic.
		const command = (text: string, updateId: number, thread?: number) =>
			deliver({
				update_id: updateId,
				message: {
					message_id: 950 + updateId,
					...(thread
						? { message_thread_id: thread, is_topic_message: true }
						: {}),
					chat: { id: Number(chatId) },
					from: { id: ownerId, is_bot: false },
					text,
				},
			});
		await command("/topup agent@example.com", 41, 8);
		expect(sent()[2]?.body).toMatchObject({ message_thread_id: 8 });
		await command("/topup agent@example.com 300", 42, 8);
		expect(sent()[3]?.body.message_thread_id).toBe(5);
		await command("/topup agent@example.com", 43);
		expect(sent()[4]?.body).not.toHaveProperty("message_thread_id");
	});

	it("tops up a partner wallet from /topup after the owner confirms, retrying safely", async () => {
		await ensureOwnerAlertWebhook(db, { fetcher });
		expect(
			telegram.find((call) => call.method === "setMyCommands")?.body,
		).toMatchObject({
			scope: { type: "chat", chat_id: chatId },
			commands: [
				{ command: "vip" },
				{ command: "vipprice" },
				{ command: "vipdel" },
				{ command: "topup" },
			],
		});
		const command = (fromId: number, text: string, updateId: number) =>
			deliver({
				update_id: updateId,
				message: {
					message_id: 950 + updateId,
					chat: { id: Number(chatId) },
					from: { id: fromId, is_bot: false },
					text,
				},
			});
		const said = () =>
			telegram
				.filter((call) => call.method === "sendMessage")
				.map((call) => String(call.body.text));

		await command(memberId, "/topup agent@example.com 300", 30);
		await command(
			ownerId,
			"/topup@laoshirenai_ops_alert_bot agent@example.com",
			31,
		);
		expect(said()).toEqual([
			"只有群主可以操作",
			"用法：/topup 邮箱 金额，例如 /topup agent@example.com 300",
		]);
		expect(program).toEqual([]);

		await command(ownerId, "/topup Agent@Example.com 300", 32);
		const proposal = telegram.filter(
			(call) => call.method === "sendMessage",
		)[2];
		expect(proposal?.body.text).toContain(
			"账号：agent@example.com（子站代理）",
		);
		expect(proposal?.body.text).toContain("充值：¥300.00 → 充值后约 ¥830.00");
		const keyboard = (
			proposal?.body.reply_markup as {
				inline_keyboard: { text: string; callback_data: string }[][];
			}
		).inline_keyboard;
		expect(keyboard.map((row) => row[0]?.text)).toEqual([
			"✅ 确认充值 ¥300.00",
			"❌ 取消",
		]);
		const confirm = keyboard[0]?.[0]?.callback_data ?? "";
		const tapAt = (updateId: number) =>
			deliver({
				update_id: updateId,
				callback_query: {
					id: `cb-${updateId}`,
					data: confirm,
					from: { id: ownerId, is_bot: false },
					message: { message_id: 779, chat: { id: Number(chatId) } },
				},
			});

		topUpFailures = 1;
		await tapAt(33);
		await expect(
			db.prepare("SELECT status FROM owner_action_requests").first("status"),
		).resolves.toBe("pending");
		expect(telegram.some((call) => call.method === "editMessageText")).toBe(
			false,
		);

		await tapAt(34);
		const credits = program.filter((call) =>
			call.path.endsWith("/wallet-topups"),
		);
		expect(credits).toHaveLength(2);
		const [firstBody, secondBody] = credits.map(
			(call) => call.body as Record<string, string>,
		);
		expect(secondBody).toEqual(firstBody);
		expect(firstBody).toMatchObject({
			email: "agent@example.com",
			amount: "300.00",
			operator: `telegram:${ownerId}`,
		});
		expect(firstBody?.request_ref).toMatch(/^TG-\d{12}-[0-9a-f]{8}$/);
		const edit = telegram.find((call) => call.method === "editMessageText");
		expect(edit?.body.text).toContain(
			"✅ 已充值 ¥300.00：余额 ¥530.00 → ¥830.00（流水 #95）",
		);
	});

	it("stays quiet about SKUs that are not on sale or not supplier-fulfilled", async () => {
		await ensureOwnerAlertWebhook(db, { fetcher });
		await db
			.prepare(
				"UPDATE products SET status = 'draft' WHERE id = 'gemini-product'",
			)
			.run();
		await syncTwice();
		// The binding is still marked deleted and the SKU stopped, just without a message.
		expect(
			await db
				.prepare(
					"SELECT remote_status FROM supplier_bindings WHERE id = 'gemini-binding'",
				)
				.first("remote_status"),
		).toBe("deleted");
		expect(telegram.some((call) => call.method === "sendMessage")).toBe(false);
	});

	it("rejects a forged webhook secret", async () => {
		await expect(
			processOwnerAlertWebhook(
				{ db, cache, now: 1, fetcher },
				JSON.stringify({ update_id: 1 }),
				"forged",
			),
		).rejects.toMatchObject({ code: "invalid_secret" });
	});

	it("never overwrites a webhook that belongs to something else", async () => {
		webhookUrl = "https://elsewhere.example/hook";
		await expect(ensureOwnerAlertWebhook(db, { fetcher })).resolves.toEqual({
			status: "blocked",
			code: "owner_webhook_conflict",
		});
		expect(telegram.some((call) => call.method === "setWebhook")).toBe(false);
		// A blocked registration is retried hourly, not on every cron tick.
		const before = telegram.length;
		await ensureOwnerAlertWebhook(db, { fetcher });
		expect(telegram.length).toBe(before);

		// Without a webhook the proposal arrives as plain text, without buttons.
		await syncTwice();
		const message = telegram.find((call) => call.method === "sendMessage");
		expect(message?.body.text).toContain("请到后台「供货」切换来源");
		expect(message?.body.reply_markup).toBeUndefined();
	});
});

async function seedAccount(db: D1Database, commerceSecret: string) {
	const encrypted = await createSupplierCredentialVault(
		"dujiao_next",
		{ apiKey: "api-a", apiSecret: "secret" },
		commerceSecret,
	);
	await db
		.prepare(
			`INSERT INTO supplier_accounts
			 (id, provider, base_url, normalized_api_origin, protocol_version,
			  currency, currency_decimals, name, credentials_encrypted,
			  credentials_revision, credential_fingerprint, enabled,
			  health_status, created_at, updated_at)
			 VALUES ('account-a', 'dujiao_next', 'https://supplier.example',
			  'https://supplier.example', '1.3.1-upstream-v1', 'CNY', 2,
			  'account-a', ?, 1, 'fingerprint-a', 1, 'healthy', 1, 1)`,
		)
		.bind(encrypted)
		.run();
}

/** Bound to upstream 9/9, which the catalog no longer lists; 1/2 has the same name. */
async function seedDelistedBinding(db: D1Database) {
	await db.batch([
		db.prepare(
			`INSERT INTO products
			 (id, name, description, product_type, status, created_at, updated_at)
			 VALUES ('gemini-product', 'Gemini Pro', '', 'stock', 'active', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO product_sellable_items
			 (id, product_id, name, fulfillment_source, supplier_status,
			  currency, currency_decimals, price_minor, cost_minor,
			  created_at, updated_at)
			 VALUES ('gemini-item', 'gemini-product', '18个月', 'supplier',
			  'available', 'CNY', 2, '1000', '120', 1, 1)`,
		),
		db.prepare(
			`INSERT INTO supplier_bindings
			 (id, sellable_item_id, provider, normalized_api_origin,
			  protocol_version, upstream_product_id, upstream_sku_id,
			  upstream_product_name, upstream_sku_name, reference_cost_minor,
			  max_cost_minor, stock_quantity, remote_status, last_synced_at,
			  enabled, created_at, updated_at)
			 VALUES ('gemini-binding', 'gemini-item', 'dujiao_next',
			  'https://supplier.example', '1.3.1-upstream-v1', '9', '9',
			  '商品', 'SKU', '120', '150', 5, 'active', 1, 1, 1, 1)`,
		),
	]);
}

function catalogResponse() {
	return Response.json({
		total: 1,
		items: [
			{
				id: 1,
				title: { "zh-CN": "商品" },
				description: {},
				images: [],
				tags: [],
				currency: "CNY",
				is_active: true,
				skus: [
					{
						id: 2,
						sku_code: "SKU",
						spec_values: {},
						price_amount: "1.00",
						stock_quantity: 10,
						is_active: true,
					},
				],
			},
		],
	});
}

describe("rebind proposal numbering", () => {
	it("numbers only choosable candidates, in button order", async () => {
		const { formatRebindProposal, rebindChoiceLabel } = await import(
			"#/features/suppliers/server/rebind-proposal"
		);
		const candidate = (id: string, costMinor: string) => ({
			product: {
				id,
				name: "商品",
				description: "",
				imageUrls: [],
				categoryNames: [],
				active: true,
				skus: [],
			},
			sku: { id, name: "SKU", costMinor, stockQuantity: 1, active: true },
		});
		const delisted = {
			bindingId: "b",
			sellableItemId: "i",
			productName: "P",
			sellableItemName: "I",
			upstreamProductId: "old",
			upstreamProductName: "商品",
			upstreamSkuName: "SKU",
			maxCostMinor: "150",
			priceMinor: "1000",
		};
		const all = [
			candidate("A", "200"),
			candidate("B", "100"),
			candidate("C", "120"),
		];
		const text = formatRebindProposal(
			"https://supplier.example",
			delisted,
			all,
		);
		expect(text).toContain("新1：商品（编号 B）");
		expect(text).toContain("新2：商品（编号 C）");
		expect(text).toContain("另有：商品（编号 A）");
		const choices = all.slice(1);
		expect(
			choices.map((_, index) => rebindChoiceLabel(choices, index)),
		).toEqual(["✅ 换成新1", "✅ 换成新2"]);
	});
});
