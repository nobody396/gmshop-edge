import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleSupplierTopUpClaim,
	handleSupplierTopUpOffer,
	handleSupplierTopUpResult,
} from "#/features/supplier-topup/server/api";
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
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { createInitialRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

const botToken = "1234567890:AAtest-only-owner-alert-token_abcdefgh";
const chatId = "-1004407917651";
const ownerId = 42;
const alertToken = "alert-token-for-tests";
const runnerToken = "runner-token-for-tests";
// 1x1 PNG.
const png =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

type TelegramCall = {
	method: string;
	body: Record<string, unknown>;
	messageId?: number;
};
type Keyboard = {
	inline_keyboard: { text: string; callback_data: string }[][];
};

describe("supplier top-up buttons on the low-balance alert", {
	timeout: 30_000,
}, () => {
	let miniflare: Miniflare;
	let db: D1Database;
	let cache: KVNamespace;
	let telegram: TelegramCall[];
	let now: number;
	let nextMessageId: number;
	let updateId: number;
	let webhookUrl: string;
	const runtime = createInitialRuntimeConfig("https://shop.example");

	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = url.pathname.split("/").at(-1) ?? "";
		if (init?.body instanceof FormData) {
			const body = Object.fromEntries(
				[...init.body.entries()].map(([key, value]) => [
					key,
					typeof value === "string" ? value : `blob:${value.size}`,
				]),
			);
			telegram.push({ method, body });
			return Response.json({
				ok: true,
				result: { message_id: nextMessageId++ },
			});
		}
		const body = JSON.parse(String(init?.body ?? "{}"));
		const call: TelegramCall = { method, body };
		telegram.push(call);
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
		if (method === "sendMessage") {
			call.messageId = nextMessageId++;
			return Response.json({
				ok: true,
				result: { message_id: call.messageId },
			});
		}
		return Response.json({ ok: true, result: true });
	};

	const env = () =>
		({
			DB: db,
			SUPPLIER_ALERT_TOKEN: alertToken,
			SUPPLIER_TOPUP_RUNNER_TOKEN: runnerToken,
		}) as CloudflareBindings;

	function post(path: string, token: string, body: unknown) {
		return new Request(`https://shop.example/api/ops/supplier-topup/${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	}

	async function offer(supplierId = "pomoai") {
		const response = await handleSupplierTopUpOffer(
			post("offer", alertToken, {
				supplier_id: supplierId,
				supplier_name: supplierId === "pomoai" ? "PomoAI" : "星湾",
				text: "🟡 PomoAI 余额不足，请充值\n\n余额：¥62.67",
			}),
			env(),
			{ now, fetcher },
		);
		return { status: response.status, body: await response.json() };
	}

	async function claim() {
		const response = await handleSupplierTopUpClaim(
			post("claim", runnerToken, {}),
			env(),
			{ now, fetcher },
		);
		return ((await response.json()) as { job: Record<string, unknown> | null })
			.job;
	}

	async function result(body: Record<string, unknown>) {
		const response = await handleSupplierTopUpResult(
			post("result", runnerToken, body),
			env(),
			{ now, fetcher },
		);
		return { status: response.status, body: await response.json() };
	}

	function lastProposal() {
		const call = [...telegram]
			.reverse()
			.find(
				(item: TelegramCall) =>
					item.method === "sendMessage" &&
					(item.body.reply_markup as Keyboard | undefined)?.inline_keyboard,
			);
		if (!call?.messageId) throw new Error("no proposal");
		return {
			text: String(call.body.text),
			messageId: call.messageId,
			buttons: (call.body.reply_markup as Keyboard).inline_keyboard.map(
				(row) => row[0] as { text: string; callback_data: string },
			),
		};
	}

	async function tap(proposal: ReturnType<typeof lastProposal>, index: number) {
		const credentials = await resolveTelegramOwnerAlertCredentials(db);
		if (!credentials) throw new Error("telegram not configured");
		updateId += 1;
		return processOwnerAlertWebhook(
			{ db, cache, now, fetcher },
			JSON.stringify({
				update_id: updateId,
				callback_query: {
					id: `cb-${updateId}`,
					data: proposal.buttons[index]?.callback_data,
					from: { id: ownerId, is_bot: false },
					message: {
						message_id: proposal.messageId,
						chat: { id: Number(chatId) },
					},
				},
			}),
			(await ownerWebhookSecret(db, credentials)) ?? "",
		);
	}

	const sent = (text: string) =>
		telegram.filter(
			(call) =>
				call.method === "sendMessage" && String(call.body.text).includes(text),
		);

	beforeEach(async () => {
		telegram = [];
		now = 1_800_011_000_000;
		nextMessageId = 500;
		updateId = 0;
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
		await db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES ('runtime.data_encryption_secret', ?, 1, 1, 1),
				        ('runtime.better_auth_url', ?, 0, 1, 1)`,
			)
			.bind(
				JSON.stringify(runtime.dataEncryptionSecret),
				JSON.stringify("https://shop.example"),
			)
			.run();
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
	});

	afterEach(async () => miniflare.dispose());

	it("runs alert → amount → QR → not paid yet → paid → balance, one job per tap", async () => {
		expect((await offer()).body).toMatchObject({ ok: true, status: "offered" });
		const alert = lastProposal();
		expect(alert.text).toContain("PomoAI 余额不足");
		expect(alert.buttons.map((b) => b.text)).toEqual([
			"💳 充 ¥50",
			"💳 充 ¥100",
			"💳 充 ¥200",
			"🙅 不充值",
		]);

		await tap(alert, 1);
		// A second tap on the same alert does not queue another order.
		await tap(alert, 2);
		const job = await claim();
		expect(job).toMatchObject({
			step: "create",
			supplier_id: "pomoai",
			amount_cny: 100,
		});
		expect(await claim()).toBeNull();

		// A new alert while the order is open gets no buttons.
		expect((await offer()).body).toMatchObject({ status: "open_topup" });
		expect(sent("已有一笔 ¥100 的充值正在下单")).toHaveLength(1);

		expect(
			(
				await result({
					job_id: job?.id,
					outcome: "order_created",
					channel: "微信",
					total_cny: "100.00",
					orders: [
						{
							reference: "LD261026ABC",
							amount_cny: "100.00",
							qr_png_base64: png,
						},
					],
				})
			).body,
		).toMatchObject({ status: "recorded" });
		const photo = telegram.find((call) => call.method === "sendPhoto");
		expect(photo?.body.caption).toContain("请用「微信」扫码付款");
		expect(photo?.body.caption).toContain("LD261026ABC");
		expect(String(photo?.body.photo)).toMatch(/^blob:\d+/);
		// The runner re-reporting the same job changes nothing.
		expect(
			(await result({ job_id: job?.id, outcome: "unpaid" })).body,
		).toMatchObject({
			status: "duplicate",
		});

		const paid = lastProposal();
		expect(paid.buttons.map((b) => b.text)).toEqual([
			"✅ 充值完成",
			"❌ 不充值了",
		]);
		await tap(paid, 0);
		const collect = await claim();
		expect(collect).toMatchObject({
			step: "collect",
			topup_id: job?.id,
			order: { channel: "微信", orders: [{ reference: "LD261026ABC" }] },
		});
		await result({ job_id: collect?.id, outcome: "unpaid" });
		const again = lastProposal();
		expect(again.text).toContain("还没查到 PomoAI ¥100.00 的付款");

		await tap(again, 0);
		const collect2 = await claim();
		await result({
			job_id: collect2?.id,
			outcome: "collected",
			balance_cny: "162.67",
			balance_checked_at: "10-26 17:05",
			ledger_ids: [561],
		});
		expect(sent("最新余额：¥162.67")).toHaveLength(1);
		expect(sent("账 #561")).toHaveLength(1);

		// Closed: the next alert offers amounts again.
		expect((await offer()).body).toMatchObject({ status: "offered" });
	});

	it("closes the alert on 不充值 and abandons an unpaid order on 不充值了", async () => {
		await offer();
		await tap(lastProposal(), 3);
		expect(await claim()).toBeNull();
		const edit = [...telegram]
			.reverse()
			.find((call: TelegramCall) => call.method === "editMessageText");
		expect(edit?.body.text).toContain("不充值，这次提醒已关闭");

		await offer();
		await tap(lastProposal(), 0);
		const job = await claim();
		await result({
			job_id: job?.id,
			outcome: "order_created",
			channel: "支付宝",
			total_cny: "50.00",
			orders: [{ reference: "R1", amount_cny: "50.00", qr_png_base64: png }],
		});
		await tap(lastProposal(), 1);
		const row = await db
			.prepare("SELECT status FROM supplier_topup_jobs WHERE id = ?")
			.bind(job?.id)
			.first();
		expect(row).toEqual({ status: "abandoned" });
		expect((await offer()).body).toMatchObject({ status: "offered" });
	});

	it("reports an uncertain order once and never re-queues it", async () => {
		await offer();
		await tap(lastProposal(), 2);
		const job = await claim();
		await result({
			job_id: job?.id,
			outcome: "uncertain",
			reason: "下单接口超时",
		});
		expect(sent("下单结果不确定")).toHaveLength(1);
		expect(await claim()).toBeNull();
	});

	it("supersedes older alert buttons and rejects bad tokens and suppliers", async () => {
		await offer();
		const first = lastProposal();
		await offer();
		expect(
			[...telegram]
				.reverse()
				.find((c: TelegramCall) => c.method === "editMessageText")?.body,
		).toMatchObject({
			message_id: first.messageId,
			reply_markup: { inline_keyboard: [] },
		});
		await tap(first, 0);
		expect(await claim()).toBeNull();

		const forged = await handleSupplierTopUpClaim(
			post("claim", alertToken, {}),
			env(),
			{ now, fetcher },
		);
		expect(forged.status).toBe(401);
		expect((await offer("unknown")).status).toBe(422);
	});
});
