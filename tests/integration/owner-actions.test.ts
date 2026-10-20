import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
				return Response.json({ ok: true, result: { message_id: 777 } });
			return Response.json({ ok: true, result: true });
		}
		if (url.pathname.endsWith("/categories"))
			return Response.json({ ok: true, categories: [] });
		return catalogResponse();
	};

	beforeEach(async () => {
		telegram = [];
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

	async function tap(fromId: number, data: string, updateId: number) {
		const credentials = await resolveTelegramOwnerAlertCredentials(db);
		if (!credentials) throw new Error("telegram not configured");
		const secret = (await ownerWebhookSecret(db, credentials)) ?? "";
		return processOwnerAlertWebhook(
			{ db, cache, now: 1_800_011_000_000, fetcher },
			JSON.stringify({
				update_id: updateId,
				callback_query: {
					id: `cb-${updateId}`,
					data,
					from: { id: fromId, is_bot: false },
					message: { message_id: 777, chat: { id: Number(chatId) } },
				},
			}),
			secret,
		);
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
					allowed_updates: ["callback_query"],
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
