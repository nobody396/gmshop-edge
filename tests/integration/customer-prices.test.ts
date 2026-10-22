import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCustomerPriceGuard } from "#/features/customer-pricing/server/telegram";
import { createMultiStoreOrder } from "#/features/storefront/server/multi-order";
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
const plusId = "11111111-1111-4111-8111-111111111111";
const proId = "22222222-2222-4222-8222-222222222222";
const alipayId = "33333333-3333-4333-8333-333333333333";
// 2026-10-23 09:31 Beijing.
const morning = Date.UTC(2026, 9, 23, 1, 31);

type TelegramCall = { method: string; body: Record<string, unknown> };
type Keyboard = {
	inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

describe("customer prices from the owner chat", { timeout: 30_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let telegram: TelegramCall[];
	let updateId: number;
	const runtime = createInitialRuntimeConfig("https://shop.example");

	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = url.pathname.split("/").at(-1) ?? "";
		const body = JSON.parse(String(init?.body ?? "{}"));
		telegram.push({ method, body });
		if (method === "getWebhookInfo")
			return Response.json({ ok: true, result: { url: "" } });
		if (method === "getChatMember")
			return Response.json({
				ok: true,
				result: { status: body.user_id === ownerId ? "creator" : "member" },
			});
		if (method === "sendMessage")
			return Response.json({
				ok: true,
				result: { message_id: 500 + telegram.length },
			});
		return Response.json({ ok: true, result: true });
	};

	async function deliver(update: Record<string, unknown>) {
		const credentials = await resolveTelegramOwnerAlertCredentials(db);
		if (!credentials) throw new Error("telegram not configured");
		updateId += 1;
		return processOwnerAlertWebhook(
			{ db, cache: undefined, now: morning, fetcher },
			JSON.stringify({ update_id: updateId, ...update }),
			(await ownerWebhookSecret(db, credentials)) ?? "",
		);
	}
	const command = (text: string) =>
		deliver({
			message: {
				message_id: 900 + updateId,
				chat: { id: Number(chatId) },
				from: { id: ownerId, is_bot: false },
				text,
			},
		});
	const lastMessage = () =>
		telegram.filter((call) => call.method === "sendMessage").at(-1);
	async function press(label: string) {
		const message = telegram
			.filter((call) => call.method === "sendMessage" && call.body.reply_markup)
			.at(-1);
		const keyboard = message?.body.reply_markup as Keyboard;
		const button = keyboard.inline_keyboard
			.flat()
			.find((entry) => entry.text.startsWith(label));
		if (!button) throw new Error(`no button ${label}`);
		const messageId = 500 + telegram.indexOf(message as TelegramCall) + 1;
		return deliver({
			callback_query: {
				id: `cb-${updateId}`,
				data: button.callback_data,
				from: { id: ownerId, is_bot: false },
				message: { message_id: messageId, chat: { id: Number(chatId) } },
			},
		});
	}
	const order = (
		quantity: number,
		channel?: string,
		key = crypto.randomUUID(),
	) =>
		createMultiStoreOrder(
			db,
			{
				email: "vip@example.com",
				idempotencyKey: key,
				customerNote: "",
				items: [{ sellableItemId: plusId, quantity, inputValues: {} }],
			},
			{ userId: "vip", pricingChannelId: channel },
		).then((created) =>
			db
				.prepare(
					"SELECT unit_price_minor, price_source FROM shop_order_items WHERE order_id = ?",
				)
				.bind(created.id)
				.first(),
		);

	beforeEach(async () => {
		telegram = [];
		updateId = 0;
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		const stock = Array.from({ length: 12 }, (_, index) =>
			db.prepare(
				`INSERT INTO stock_entries (id, sellable_item_id, content_encrypted, key_version, content_fingerprint, content_mask, status, created_at, updated_at)
				 VALUES ('stock-${index}', '${plusId}', 'cipher', 1, 'fp-${index}', '••••', 'available', 1, 1)`,
			),
		);
		await db.batch([
			db
				.prepare(
					`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
					 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1), ('runtime.better_auth_url', ?, 0, 1, 1)`,
				)
				.bind(
					JSON.stringify(runtime.dataEncryptionSecret),
					JSON.stringify("https://shop.example"),
				),
			db.prepare(
				`INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('vip', 'VIP', 'VIP@Example.com', 1, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO products (id, name, product_type, status, created_at, updated_at) VALUES ('p', 'ChatGPT 会员充值', 'stock', 'active', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO product_sellable_items (id, product_id, name, currency, currency_decimals, price_minor, cost_minor, maximum_quantity, created_at, updated_at)
				 VALUES ('${plusId}', 'p', 'ChatGPT Plus｜菲区｜1个月', 'CNY', 2, '11900', '11200', 50, 1, 1),
				        ('${proId}', 'p', 'ChatGPT Pro 200｜菲区续费｜1个月', 'CNY', 2, '109800', '105000', 50, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO payment_channels (id, provider, name, currency, fee_bps, fixed_fee_minor, enabled, created_at, updated_at)
				 VALUES ('${alipayId}', 'epay', '支付宝', 'CNY', 160, '0', 1, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO sellable_item_channel_prices (id, sellable_item_id, channel_id, price_minor, enabled, created_at, updated_at)
				 VALUES ('cp-plus', '${plusId}', '${alipayId}', '12500', 1, 1, 1), ('cp-pro', '${proId}', '${alipayId}', '113800', 1, 1, 1)`,
			),
			...stock,
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
		await ensureOwnerAlertWebhook(db, { fetcher });
		telegram = [];
	});

	afterEach(async () => miniflare.dispose());

	it("sets a customer's step price after the owner confirms, and the order charges it on every channel", async () => {
		await command("/vipprice vip@example.com Plus菲区 10张起 113");
		const card = String(lastMessage()?.body.text);
		expect(card).toContain("客户：VIP@Example.com");
		expect(card).toContain("数量：10 张起");
		expect(card).toContain("专属价：USDT ¥113.00 / 支付宝 ¥119.00");
		expect(card).toContain("进价 ¥112.00，每张赚：USDT ¥1.00");
		// Nothing changes before the confirmation.
		expect(await order(10)).toEqual({
			unit_price_minor: "11900",
			price_source: "list",
		});
		await press("✅ 确认设置");
		expect(await order(9)).toEqual({
			unit_price_minor: "11900",
			price_source: "list",
		});
		expect(await order(10)).toEqual({
			unit_price_minor: "11300",
			price_source: "customer",
		});
		expect(await order(10, alipayId)).toEqual({
			unit_price_minor: "11900",
			price_source: "customer",
		});

		await command("/vip vip@example.com");
		expect(lastMessage()?.body.text).toContain(
			"ChatGPT Plus｜菲区｜1个月｜10 张起｜USDT ¥113.00 / 支付宝 ¥119.00",
		);

		await command("/vipdel vip@example.com Plus菲区");
		await press("✅ 确认删除");
		expect(await order(10)).toEqual({
			unit_price_minor: "11900",
			price_source: "list",
		});
	});

	it("names an Alipay price, warns below cost, and lets the owner pick among several plans", async () => {
		await command("/vipprice vip@example.com Plus菲区 110/115");
		const card = String(lastMessage()?.body.text);
		expect(card).toContain("支付宝 ¥115.00");
		expect(card).toContain("⚠️ 低于进价");
		await press("✅ 确认设置");
		expect(await order(1, alipayId)).toEqual({
			unit_price_minor: "11500",
			price_source: "customer",
		});

		await command("/vipprice vip@example.com 菲区 100");
		const keyboard = lastMessage()?.body.reply_markup as Keyboard;
		expect(keyboard.inline_keyboard.map((row) => row[0]?.text)).toEqual([
			"1. ChatGPT 会员充值｜ChatGPT Plus｜菲区｜1个月",
			"2. ChatGPT 会员充值｜ChatGPT Pro 200｜菲区续费｜1个月",
			"❌ 取消",
		]);
	});

	it("refuses unknown customers and products without touching prices", async () => {
		await command("/vipprice nobody@example.com Plus菲区 113");
		expect(lastMessage()?.body.text).toContain("找不到已注册的账号");
		await command("/vipprice vip@example.com Gemini 113");
		expect(lastMessage()?.body.text).toContain("找不到商品");
		await command("/vipprice vip@example.com Plus菲区");
		expect(lastMessage()?.body.text).toContain("用法");
		expect(
			await db
				.prepare("SELECT COUNT(*) AS n FROM customer_item_prices")
				.first(),
		).toEqual({ n: 0 });
	});

	it("proposes a raise once per cost level when a customer price starts losing money", async () => {
		await command("/vipprice vip@example.com Plus菲区 115");
		await press("✅ 确认设置");
		await db
			.prepare(
				`UPDATE product_sellable_items SET cost_minor = '11600' WHERE id = '${plusId}'`,
			)
			.run();
		await expect(
			runCustomerPriceGuard({ db, now: morning, fetcher }),
		).resolves.toEqual({ status: "ran", proposals: 1 });
		const card = String(lastMessage()?.body.text);
		expect(card).toContain("客户专属价开始亏钱");
		expect(card).toContain("上调到 USDT ¥119.00");
		// Same cost the next day: no second proposal.
		await expect(
			runCustomerPriceGuard({ db, now: morning + 86_400_000, fetcher }),
		).resolves.toEqual({ status: "ran", proposals: 0 });
		await press("✅ 上调到 ¥119.00");
		expect(await order(1)).toEqual({
			unit_price_minor: "11900",
			price_source: "list",
		});
		expect(
			await db.prepare("SELECT price_minor FROM customer_item_prices").first(),
		).toEqual({ price_minor: "11900" });
	});
});
