import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	recordBulkSale,
	runBulkProcurements,
	topUpBulkCodeStock,
} from "#/features/redeem-warehouse/server/bulk-procurement";
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
import { encryptSecret } from "#/lib/secrets";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

const botToken = "1234567890:AAtest-only-owner-alert-token_abcdefgh";
const chatId = "-5101401750";
const ownerId = 42;
const hashes = ["a", "b", "c"].map((letter) => letter.repeat(64));

type TelegramCall = { method: string; body: Record<string, unknown> };

describe("bulk AISOU procurement after a bulk sale", {
	timeout: 30_000,
}, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let telegram: TelegramCall[];
	let warehouse: Array<{ path: string; body: Record<string, unknown> }>;
	let replies: Array<Record<string, unknown>>;
	let webhookUrl: string;
	let telegramDown: boolean;
	const runtime = createInitialRuntimeConfig("https://shop.example");

	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = url.pathname.split("/").at(-1) ?? "";
		const body = JSON.parse(String(init?.body ?? "{}"));
		if (telegramDown) return new Response("bad gateway", { status: 502 });
		telegram.push({ method, body });
		if (method === "getWebhookInfo")
			return Response.json({ ok: true, result: { url: webhookUrl } });
		if (method === "setWebhook") {
			webhookUrl = String(body.url);
			return Response.json({ ok: true, result: true });
		}
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
						700 +
						telegram.filter((call) => call.method === "sendMessage").length,
				},
			});
		return Response.json({ ok: true, result: true });
	};
	const requester = async (
		_token: string,
		path: string,
		init: RequestInit = {},
	) => {
		warehouse.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
		return {
			success: true,
			data: replies.shift() ?? { status: "in_progress" },
		};
	};
	const run = (now: number) =>
		runBulkProcurements({ db, now, fetcher, requester: requester as never });
	const sent = () => telegram.filter((call) => call.method === "sendMessage");
	const state = async () =>
		db
			.prepare(
				"SELECT state, notified_state, accept_unit_minor FROM bulk_procurements",
			)
			.first<{
				state: string;
				notified_state: string | null;
				accept_unit_minor: string | null;
			}>();

	beforeEach(async () => {
		telegram = [];
		warehouse = [];
		replies = [];
		webhookUrl = "";
		telegramDown = false;
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		const token = await encryptSecret(
			"warehouse-token",
			runtime.commerceSecret,
			"redeem-warehouse-token",
		);
		await db.batch([
			db
				.prepare(
					`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
					 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1),
					        ('runtime.better_auth_url', ?, 0, 1, 1),
					        ('integration.redeem_warehouse_token', ?, 1, 1, 1)`,
				)
				.bind(
					JSON.stringify(runtime.dataEncryptionSecret),
					JSON.stringify("https://shop.example"),
					JSON.stringify(token),
				),
			db.prepare(
				`INSERT INTO products (id, name, product_type, status, created_at, updated_at)
				 VALUES ('p', 'ChatGPT 会员充值', 'stock', 'active', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO product_sellable_items (id, product_id, name, currency, currency_decimals, price_minor, created_at, updated_at)
				 VALUES ('i', 'p', 'ChatGPT Plus｜菲区｜1个月', 'CNY', 2, '11900', 1, 1)`,
			),
			db.prepare(
				`INSERT INTO shop_orders (id, order_number, idempotency_key, contact_email, normalized_contact_email, locale, status,
				  currency, currency_decimals, subtotal_minor, discount_minor, total_minor, paid_minor, version, expires_at, created_at, updated_at)
				 VALUES ('o', 'GMTEST0001', 'k', 'b@example.com', 'b@example.com', 'zh-CN', 'completed', 'CNY', 2, '35100', '0', '35100', '35100', 1, 1, 1, 1)`,
			),
			db.prepare(
				`INSERT INTO shop_order_items (id, order_id, product_id, sellable_item_id, product_name, delivery_component_id,
				  delivery_component_type, delivery_component_version, sellable_item_name, quantity, unit_price_minor, subtotal_minor, created_at, updated_at)
				 VALUES ('oi', 'o', 'p', 'i', 'ChatGPT 会员充值', 'i', 'stock', 1, 'ChatGPT Plus｜菲区｜1个月', 3, '11700', '35100', 1, 1)`,
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
		await ensureOwnerAlertWebhook(db, { fetcher });
		await recordBulkSale(db, {
			orderId: "o",
			orderItemId: "oi",
			sellableItemId: "i",
			sku: "GPT_PLUS_PH",
			codeHashes: hashes,
		});
		telegram = [];
	});

	afterEach(async () => miniflare.dispose());

	async function tap(data: string, messageId: number, updateId: number) {
		const credentials = await resolveTelegramOwnerAlertCredentials(db);
		if (!credentials) throw new Error("telegram not configured");
		return processOwnerAlertWebhook(
			{ db, cache: undefined, now: 1_900_000_000_000, fetcher },
			JSON.stringify({
				update_id: updateId,
				callback_query: {
					id: `cb-${updateId}`,
					data,
					from: { id: ownerId, is_bot: false },
					message: { message_id: messageId, chat: { id: Number(chatId) } },
				},
			}),
			(await ownerWebhookSecret(db, credentials)) ?? "",
		);
	}

	it("ignores a line below the bulk size and records each bulk line once", async () => {
		await recordBulkSale(db, {
			orderId: "o",
			orderItemId: "oi",
			sellableItemId: "i",
			sku: "GPT_PLUS_PH",
			codeHashes: hashes,
		});
		await recordBulkSale(db, {
			orderId: "o",
			orderItemId: "small",
			sellableItemId: "i",
			sku: "GPT_PLUS_PH",
			codeHashes: hashes.slice(0, 2),
		});
		expect(
			await db.prepare("SELECT COUNT(*) AS n FROM bulk_procurements").first(),
		).toEqual({ n: 1 });
	});

	it("asks for a top-up with the exact gap, then buys after 已充值 and reports the checked cards", async () => {
		replies.push({
			status: "funds_short",
			need: 3,
			unitFen: 11200,
			totalFen: 33600,
			balanceFen: 4600,
		});
		await run(1_900_000_000_000);
		expect(warehouse[0]).toEqual({
			path: "/api/internal/aisou/bulk",
			body: { batch_id: expect.any(String), code_hashes: hashes },
		});
		expect(await state()).toMatchObject({
			state: "awaiting_funds",
			notified_state: "awaiting_funds",
		});
		const prompt = sent()[0];
		expect(prompt?.body.text).toContain("还差 ¥290.00");
		expect(prompt?.body.text).toContain("订单 GMTEST0001｜实收 ¥351.00");
		const buttons = (
			prompt?.body.reply_markup as {
				inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
			}
		).inline_keyboard;
		expect(buttons.map((row) => row[0]?.text)).toEqual([
			"✅ 已充值，重新进货",
			"🚫 这批不进了（兑换时单张进货）",
		]);

		// Nothing is retried on its own while waiting for the owner.
		await run(1_900_000_060_000);
		expect(warehouse).toHaveLength(1);

		await tap(String(buttons[0]?.[0]?.callback_data), 701, 1);
		expect(await state()).toMatchObject({
			state: "pending",
			notified_state: null,
		});
		replies.push({
			status: "verifying",
			need: 3,
			amount: "336.00",
			quoted_total: "336.00",
			balance_after: "64.00",
			trade_no: "T1",
		});
		await run(1_900_000_120_000);
		expect(await state()).toMatchObject({ state: "verifying" });
		expect(sent().at(-1)?.body.text).toContain(
			"已从 AISOU 一次进货 3 张，实扣 ¥336.00",
		);
		// Still being checked a minute later: no second message.
		replies.push({ status: "verifying", need: 3 });
		await run(1_900_000_180_000);
		const before = sent().length;
		replies.push({
			status: "supplied",
			need: 3,
			ready: 3,
			amount: "336.00",
			trade_no: "T1",
		});
		await run(1_900_000_240_000);
		expect(sent()).toHaveLength(before + 1);
		expect(sent().at(-1)?.body.text).toContain("验卡完成：3 张全部可用");
		expect(await state()).toMatchObject({ state: "supplied" });
	});

	it("stops when AISOU is short and skips the batch on 这批不进了", async () => {
		replies.push({ status: "stock_short", need: 3, stock: 2 });
		await run(1_900_000_000_000);
		const prompt = sent()[0];
		expect(prompt?.body.text).toContain("AISOU 这款只剩 2 张，这批要 3 张");
		const buttons = (
			prompt?.body.reply_markup as {
				inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
			}
		).inline_keyboard;
		expect(buttons[0]?.[0]?.text).toBe("✅ 已补货，重新进货");
		await tap(String(buttons[1]?.[0]?.callback_data), 701, 2);
		await run(1_900_000_060_000);
		expect(await state()).toMatchObject({ state: "skipped" });
		// The warehouse releases the codes for single purchases at redemption.
		expect(warehouse).toHaveLength(2);
		expect(warehouse[1]?.body).toEqual({
			batch_id: expect.any(String),
			release: true,
		});
	});

	it("passes the accepted unit price after the owner agrees to a changed quote", async () => {
		replies.push({
			status: "price_changed",
			need: 3,
			unitFen: 11300,
			expectedUnitFen: 11200,
			totalFen: 33900,
		});
		await run(1_900_000_000_000);
		const buttons = (
			sent()[0]?.body.reply_markup as {
				inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
			}
		).inline_keyboard;
		expect(buttons[0]?.[0]?.text).toBe("✅ 按 ¥113.00/张进货");
		await tap(String(buttons[0]?.[0]?.callback_data), 701, 3);
		expect(await state()).toMatchObject({
			state: "pending",
			accept_unit_minor: "11300",
		});
		replies.push({ status: "verifying", need: 3 });
		await run(1_900_000_060_000);
		expect(warehouse.at(-1)?.body).toMatchObject({ accept_unit_fen: 11300 });
	});

	it("cancels a refunded order before buying and stays silent for SKUs without a bulk source", async () => {
		await db.prepare("UPDATE shop_orders SET status = 'refunded'").run();
		await run(1_900_000_000_000);
		// Nothing is bought; the warehouse only releases the codes it was holding for this batch.
		expect(warehouse).toEqual([
			{
				path: "/api/internal/aisou/bulk",
				body: { batch_id: expect.any(String), release: true },
			},
		]);
		expect(await state()).toMatchObject({ state: "cancelled" });
		expect(sent()[0]?.body.text).toContain("订单已退款，这批不进货");

		await db
			.prepare(
				"UPDATE bulk_procurements SET state = 'pending', notified_state = NULL",
			)
			.run();
		await db.prepare("UPDATE shop_orders SET status = 'completed'").run();
		replies.push({ status: "not_bulk" });
		const before = sent().length;
		await run(1_900_000_060_000);
		expect(await state()).toMatchObject({ state: "skipped" });
		expect(sent()).toHaveLength(before);
	});

	it("retries an unreachable warehouse quietly, then hands it to review", async () => {
		for (let minute = 0; minute < 15; minute += 1) {
			await db
				.prepare("UPDATE bulk_procurements SET next_attempt_at = 0")
				.run();
			await run(1_900_000_000_000 + minute * 60_000);
		}
		expect(await state()).toMatchObject({ state: "review" });
		expect(sent()).toHaveLength(1);
		expect(sent()[0]?.body.text).toContain("需要人工核对");
	});

	it("keeps following a trade in review and reports it once the warehouse recovers its cards", async () => {
		replies.push({
			status: "review",
			need: 3,
			trade_no: "T1",
			reason: "no cards delivered",
		});
		await run(1_900_000_000_000);
		expect(await state()).toMatchObject({ state: "review" });
		await run(1_900_000_060_000);
		expect(warehouse).toHaveLength(1);
		const reviewMessages = sent().length;
		replies.push({
			status: "review",
			need: 3,
			trade_no: "T1",
			reason: "no cards delivered",
		});
		await run(1_900_000_000_000 + 5 * 60_000);
		expect(warehouse).toHaveLength(2);
		expect(sent()).toHaveLength(reviewMessages);
		replies.push({ status: "verifying", need: 3 });
		await run(1_900_000_000_000 + 10 * 60_000);
		expect(await state()).toMatchObject({ state: "verifying" });
	});

	it("tops owned codes up to 150 for plans sold in bulk once they fall below 100, at most every ten minutes", async () => {
		await db.batch([
			db.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('integration.supply_console_map', '{"i":"GPT_PLUS_PH"}', 0, 1, 1)`,
			),
			db.prepare(
				"INSERT INTO sellable_item_volume_prices (sellable_item_id, min_quantity, discount_minor) VALUES ('i', 10, '100')",
			),
			...Array.from({ length: 46 }, (_, index) =>
				db.prepare(
					`INSERT INTO stock_entries (id, sellable_item_id, content_encrypted, key_version, content_fingerprint, content_mask, status, created_at, updated_at)
					 VALUES ('s${index}', 'i', 'c', 1, 'f${index}', 'm', 'available', 1, 1)`,
				),
			),
		]);
		const calls: Array<{ sku: string; componentId: string; count: number }> =
			[];
		const generate = (async (data: {
			sku: string;
			componentId: string;
			count: number;
		}) => {
			calls.push({
				sku: data.sku,
				componentId: data.componentId,
				count: data.count,
			});
			return { idempotent: false, imported: data.count, count: data.count };
		}) as never;
		await expect(
			topUpBulkCodeStock({ db, now: 1_900_000_000_000, generate }),
		).resolves.toEqual({ status: "ran", generated: 100 });
		expect(calls).toEqual([
			{ sku: "GPT_PLUS_PH", componentId: "i", count: 100 },
		]);
		await expect(
			topUpBulkCodeStock({ db, now: 1_900_000_060_000, generate }),
		).resolves.toEqual({ status: "waiting" });
	});

	it("keeps an unsent owner message pending and sends it once Telegram is back", async () => {
		replies.push({ status: "stock_short", need: 3, stock: 2 });
		telegramDown = true;
		await run(1_900_000_000_000);
		expect(await state()).toMatchObject({
			state: "awaiting_stock",
			notified_state: null,
		});
		telegramDown = false;
		await run(1_900_000_060_000);
		expect(await state()).toMatchObject({
			state: "awaiting_stock",
			notified_state: "awaiting_stock",
		});
		expect(sent()[0]?.body.text).toContain("AISOU 这款只剩 2 张");
		// The warehouse was asked once; the resend did not buy or quote again.
		expect(warehouse).toHaveLength(1);
		await run(1_900_000_120_000);
		expect(sent()).toHaveLength(1);
	});
});
