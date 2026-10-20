import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentAccessProducts } from "#/features/agent-access/products";
import {
	processAgentDelivery,
	reconcileAgentAccess,
} from "#/features/agent-access/server/fulfillment";
import { prepareAgentProducts } from "#/features/agent-access/server/products";
import {
	handleAgentAccessReadyEmailRequest,
	refreshAgentAccessReadyEmail,
	renderAgentAccessReadyEmail,
} from "#/features/agent-access/server/ready-email";
import { decryptNotificationMessage } from "#/features/notifications/secrets";
import {
	processNotificationDelivery,
	supportReplyEmailSender,
} from "#/features/notifications/server/delivery";
import { completeWalletStoreOrder } from "#/features/shop-payments/server/service";
import { createMultiStoreOrder } from "#/features/storefront/server/multi-order";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

const { remote } = vi.hoisted(() => ({ remote: vi.fn() }));
vi.mock("#/features/agent-access/server/client", async (original) => ({
	...(await original<typeof import("#/features/agent-access/server/client")>()),
	callAgent: remote,
}));
const userId = "a2222222-2222-4222-8222-222222222222";
const buyer = "buyer@mail-buyer.cn";
const token = "synthetic-ops-token-that-is-long-enough";

type Message = {
	to: string;
	from: string;
	subject: string;
	text: string;
	html: string;
};

describe("agent access ready email", { timeout: 30000 }, () => {
	let mf: Miniflare;
	let db: D1Database;
	let remoteDomain: string | undefined;
	beforeEach(async () => {
		mf = new Miniflare({
			modules: true,
			script: "export default {fetch(){return new Response('ok')}}",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await mf.getD1Database("DB");
		await applyMigrations(db);
		await db
			.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled,balance_minor,balance_version) VALUES (?,'Buyer',?,1,1,'50000',1)",
			)
			.bind(userId, buyer)
			.run();
		await db
			.prepare(
				`INSERT INTO system_settings(key,value) VALUES ('agent_access.enabled','true'),('commerce.default_currency','"CNY"'),('runtime.data_encryption_secret','"test-access-data-secret-32-characters"'),('runtime.better_auth_url','"https://laoshirenvip.com"')`,
			)
			.run();
		await db
			.prepare(
				"INSERT INTO notification_channel_configs (id,channel,name,provider,from_address,enabled) VALUES ('official','email','Official','cloudflare_email',?,1)",
			)
			.bind(supportReplyEmailSender)
			.run();
		await prepareAgentProducts(db);
		await db.prepare("UPDATE products SET status='active'").run();
		remoteDomain = "apple.lsrai.shop";
		remote.mockReset();
		remote.mockImplementation(async (input: { operation: string }) => {
			if (input.operation === "check") return { state: "eligible" };
			return { state: "active", userId: 71, domain: remoteDomain };
		});
	}, 30000);
	afterEach(async () => {
		await mf.dispose();
	});

	async function open(
		itemId: string = agentAccessProducts.subsite.itemId,
		locale: "zh-CN" | "en-US" = "zh-CN",
	) {
		const created = await createMultiStoreOrder(
			db,
			{
				items: [{ sellableItemId: itemId, quantity: 1 }],
				email: buyer,
				idempotencyKey: crypto.randomUUID(),
				agentAccessTermsAccepted: true,
				locale,
			},
			{ userId },
		);
		await completeWalletStoreOrder(db, { orderId: created.id, userId });
		const row = await db
			.prepare(
				"SELECT d.id AS delivery_id,o.order_number,oi.id AS order_item_id FROM delivery_records d JOIN shop_order_items oi ON oi.id=d.order_item_id JOIN shop_orders o ON o.id=oi.order_id WHERE o.id=?",
			)
			.bind(created.id)
			.first<{
				delivery_id: string;
				order_number: string;
				order_item_id: string;
			}>();
		if (!row) throw new Error("no delivery");
		return row;
	}
	const deliveries = async () =>
		(
			await db
				.prepare(
					"SELECT id,event,idempotency_key,channel_config_id,status FROM notification_deliveries WHERE event='agent_access_ready' ORDER BY created_at,id",
				)
				.all<{
					id: string;
					event: string;
					idempotency_key: string;
					channel_config_id: string;
					status: string;
				}>()
		).results;
	async function message(id: string): Promise<Message> {
		const row = await db
			.prepare(
				"SELECT message_encrypted FROM notification_deliveries WHERE id=?",
			)
			.bind(id)
			.first<{ message_encrypted: string }>();
		const secret = (await loadRuntimeConfig(db)).commerceSecret;
		return JSON.parse(
			await decryptNotificationMessage(row?.message_encrypted ?? "", secret),
		);
	}

	it("sends exactly one ready email on activation, with no password", async () => {
		const order = await open();
		expect(await processAgentDelivery(db, order.delivery_id)).toEqual({
			status: "delivered",
		});
		const rows = await deliveries();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			idempotency_key: `agent-access-ready:${order.order_item_id}:apple.lsrai.shop`,
			channel_config_id: "official",
			status: "pending",
		});
		const sent = await message(rows[0]?.id ?? "");
		expect(sent.from).toBe("老实人AI VIP <no-reply@laoshirenvip.com>");
		expect(sent.to).toBe(buyer);
		expect(sent.subject).toBe(
			"子站代理已开通｜你的店铺：https://apple.lsrai.shop",
		);
		expect(sent.text).toContain(
			`初始密码：在订单页查看 → https://laoshirenvip.com/account/orders/${order.order_number}`,
		);
		const password = String(
			remote.mock.calls
				.map(([input]) => input)
				.find((input) => input.operation === "provision")?.initialPassword,
		);
		expect(password.length).toBeGreaterThan(12);
		for (const part of [sent.subject, sent.text, sent.html]) {
			expect(part).not.toContain(password);
			expect(part).not.toContain("owner-wechat-qr");
			expect(part).not.toContain("微信");
		}
		expect(sent.html).toContain(
			'<a href="https://apple.lsrai.shop" style="color:#2563eb;font-family:Menlo,Consolas,monospace">https://apple.lsrai.shop</a>',
		);
		expect(sent.html).toContain('<a href="https://lsrai.shop"');

		// Replays of the queue message or the minute scheduler never resend.
		await processAgentDelivery(db, order.delivery_id);
		await reconcileAgentAccess(db);
		expect(await deliveries()).toHaveLength(1);
	});

	it("does not fan out for orders that were already active before deploy", async () => {
		const order = await open();
		await processAgentDelivery(db, order.delivery_id);
		// Simulate a historical active order that never had a ready email.
		await db.prepare("DELETE FROM notification_deliveries").run();
		await db.prepare("DELETE FROM outbox_events").run();
		await processAgentDelivery(db, order.delivery_id);
		await reconcileAgentAccess(db);
		expect(await deliveries()).toHaveLength(0);
	});

	it("resends once for a changed sub-site domain and never twice for the same one", async () => {
		const order = await open();
		await processAgentDelivery(db, order.delivery_id);
		const unchanged = await refreshAgentAccessReadyEmail(
			db,
			order.order_number,
		);
		expect(unchanged.email.status).toBe("duplicate");
		expect(remote).toHaveBeenLastCalledWith(
			expect.objectContaining({
				operation: "status",
				orderItemId: order.order_item_id,
				email: buyer,
			}),
		);
		remoteDomain = "orange.lsrai.shop";
		const changed = await refreshAgentAccessReadyEmail(db, order.order_number);
		expect(changed).toMatchObject({
			previousDomain: "apple.lsrai.shop",
			domain: "orange.lsrai.shop",
			email: { status: "queued" },
		});
		expect(
			await db
				.prepare("SELECT domain FROM agent_access_orders")
				.first("domain"),
		).toBe("orange.lsrai.shop");
		expect(
			(await refreshAgentAccessReadyEmail(db, order.order_number)).email.status,
		).toBe("duplicate");
		const rows = await deliveries();
		expect(rows.map((row) => row.idempotency_key)).toEqual([
			`agent-access-ready:${order.order_item_id}:apple.lsrai.shop`,
			`agent-access-ready:${order.order_item_id}:orange.lsrai.shop`,
		]);
		expect((await message(rows[1]?.id ?? "")).subject).toBe(
			"子站代理已开通｜你的店铺：https://orange.lsrai.shop",
		);
	});

	it("sends once when the stored domain was already updated but never emailed", async () => {
		const order = await open();
		await processAgentDelivery(db, order.delivery_id);
		await db.prepare("DELETE FROM notification_deliveries").run();
		remoteDomain = "mango.lsrai.shop";
		await db
			.prepare("UPDATE agent_access_orders SET domain='mango.lsrai.shop'")
			.run();
		const result = await refreshAgentAccessReadyEmail(db, order.order_number);
		expect(result).toMatchObject({
			previousDomain: "mango.lsrai.shop",
			domain: "mango.lsrai.shop",
			email: { status: "queued" },
		});
		await refreshAgentAccessReadyEmail(db, order.order_number);
		expect(await deliveries()).toHaveLength(1);
	});

	it("waits instead of sending while the renamed host is still provisioning", async () => {
		const order = await open();
		await processAgentDelivery(db, order.delivery_id);
		remote.mockImplementation(async () => ({
			state: "provisioning",
			userId: 71,
			domain: "pear.lsrai.shop",
		}));
		const result = await refreshAgentAccessReadyEmail(db, order.order_number);
		expect(result).toMatchObject({
			domain: "pear.lsrai.shop",
			email: { status: "waiting", remoteState: "provisioning" },
		});
		expect(await deliveries()).toHaveLength(1);
	});

	it("renders the API variant without a store block", async () => {
		remoteDomain = undefined;
		const order = await open(agentAccessProducts.api.itemId);
		await processAgentDelivery(db, order.delivery_id);
		const rows = await deliveries();
		expect(rows.map((row) => row.idempotency_key)).toEqual([
			`agent-access-ready:${order.order_item_id}:api`,
		]);
		const sent = await message(rows[0]?.id ?? "");
		expect(sent.subject).toBe("API 对接已开通");
		expect(sent.text).toContain("Secret 只显示一次");
		expect(sent.text).toContain("¥0.01 测试商品和测试卡密");
		expect(sent.text).not.toContain("店铺地址");
		expect(sent.text).toContain("如有问题，请在订单页点「联系客服」");
	});

	it("only uses the approved Cloudflare sender", async () => {
		await db
			.prepare(
				"UPDATE notification_channel_configs SET from_address='Other <x@example.test>'",
			)
			.run();
		const order = await open();
		await processAgentDelivery(db, order.delivery_id);
		expect(await deliveries()).toHaveLength(0);
		await db
			.prepare(
				"UPDATE notification_channel_configs SET from_address=?,provider='resend'",
			)
			.bind(supportReplyEmailSender)
			.run();
		expect(
			(await refreshAgentAccessReadyEmail(db, order.order_number)).email,
		).toEqual({ status: "skipped", reason: "sender_unavailable" });
		await db
			.prepare(
				"UPDATE notification_channel_configs SET provider='cloudflare_email'",
			)
			.run();
		const queued = await refreshAgentAccessReadyEmail(db, order.order_number);
		const id = "deliveryId" in queued.email ? queued.email.deliveryId : "";
		// A sender swapped after enqueue is refused at send time, without fallback.
		await db
			.prepare(
				"UPDATE notification_channel_configs SET from_address='Other <x@example.test>'",
			)
			.run();
		const sent: Array<{ from: unknown }> = [];
		const binding = {
			send: async (value: { from: unknown }) => {
				sent.push(value);
				return { messageId: "mock" };
			},
		} as unknown as SendEmail;
		await expect(
			processNotificationDelivery(db, id, { cloudflareEmail: binding }),
		).rejects.toMatchObject({ code: "support_email_sender_unavailable" });
		await db
			.prepare("UPDATE notification_channel_configs SET from_address=?")
			.bind(supportReplyEmailSender)
			.run();
		await expect(
			processNotificationDelivery(db, id, { cloudflareEmail: binding }),
		).resolves.toMatchObject({ status: "accepted" });
		expect(sent).toHaveLength(1);
		expect(JSON.stringify(sent[0]?.from)).toContain(
			"no-reply@laoshirenvip.com",
		);
	});

	it("honours a delivery email opt-out on the automatic path only", async () => {
		await db
			.prepare(
				"INSERT INTO notification_subscriptions (id,user_id,event,channel,enabled,created_at,updated_at) VALUES ('s1',?,'delivery_ready','email',0,0,0)",
			)
			.bind(userId)
			.run();
		const order = await open();
		await processAgentDelivery(db, order.delivery_id);
		expect(await deliveries()).toHaveLength(0);
		expect(
			(await refreshAgentAccessReadyEmail(db, order.order_number)).email.status,
		).toBe("queued");
	});

	it("writes English only for an order placed in en-US", async () => {
		const order = await open(agentAccessProducts.subsite.itemId, "en-US");
		await processAgentDelivery(db, order.delivery_id);
		const rows = await deliveries();
		expect((await message(rows[0]?.id ?? "")).subject).toBe(
			"Your sub-site is ready | Your store: https://apple.lsrai.shop",
		);
	});

	it("guards the ops resend with the existing bearer token and audits it", async () => {
		const order = await open();
		await processAgentDelivery(db, order.delivery_id);
		const call = (authorization?: string) =>
			handleAgentAccessReadyEmailRequest(
				new Request(
					"https://laoshirenvip.com/api/ops/agent-access/ready-email",
					{
						method: "POST",
						headers: authorization ? { authorization } : {},
						body: JSON.stringify({ orderNumber: order.order_number }),
					},
				),
				{ DB: db, RESTOCK_API_TOKEN: token },
			);
		expect((await call()).status).toBe(401);
		expect((await call("Bearer wrong-token")).status).toBe(401);
		remoteDomain = "orange.lsrai.shop";
		const response = await call(`Bearer ${token}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			domain: "orange.lsrai.shop",
			email: { status: "queued" },
		});
		const audit = await db
			.prepare(
				"SELECT actor_user_id,target_id,before,after FROM audit_logs WHERE action='agent_access.ready_email_resend'",
			)
			.all<{
				actor_user_id: string | null;
				target_id: string;
				before: string;
				after: string;
			}>();
		expect(audit.results).toHaveLength(1);
		expect(audit.results[0]?.target_id).toBe(order.order_item_id);
		expect(JSON.parse(audit.results[0]?.after ?? "{}")).toMatchObject({
			via: "ops",
			domain: "orange.lsrai.shop",
		});
		expect(
			(
				await handleAgentAccessReadyEmailRequest(
					new Request("https://laoshirenvip.com/x", {
						method: "POST",
						headers: { authorization: `Bearer ${token}` },
						body: JSON.stringify({ orderNumber: "GM123" }),
					}),
					{ DB: db, RESTOCK_API_TOKEN: token },
				)
			).status,
		).toBe(400);
	});

	it("protects the admin resend with delivery permission and an audit row", async () => {
		const text = await readFile(
			new URL(
				"../../src/features/agent-access/server/admin.ts",
				import.meta.url,
			),
			"utf8",
		);
		const fn = text.slice(text.indexOf("resendAgentAccessReadyEmailFn"));
		expect(fn).toContain("sameOrigin(request)");
		expect(fn).toContain('systemPermission("delivery", "update")');
		expect(fn).toContain('action: "agent_access.ready_email_resend"');
	});
});

describe("ready email content", () => {
	const base = {
		email: "buyer@example.test",
		orderUrl: "https://laoshirenvip.com/account/orders/GM1",
	};
	it("renders zh-CN sub-site text with the fallback note and real markup values", () => {
		const { text } = renderAgentAccessReadyEmail({
			...base,
			kind: "subsite",
			locale: "zh-CN",
			domain: "apple.lsrai.shop",
			requestedSubdomain: "mystore",
			subdomainFallback: "taken",
		});
		expect(text).toContain(
			"你选的名字「mystore」已被占用，已自动分配：apple.lsrai.shop",
		);
		expect(text).toContain("默认在供货价上加 5%");
		expect(text).toContain("最低不少于 3%");
		expect(text).toContain("如有问题，请在订单页点「联系客服」");
		expect(text).toContain("图文教程");
		expect(text).toContain("https://lsrai.shop/guides/reseller");
	});
	it("drops the fallback note once the host matches the requested name", () => {
		const { text } = renderAgentAccessReadyEmail({
			...base,
			kind: "subsite",
			locale: "zh-CN",
			domain: "mystore.lsrai.shop",
			requestedSubdomain: "mystore",
			subdomainFallback: "taken",
		});
		expect(text).not.toContain("已被占用");
	});
	it("renders en-US for both kinds without WeChat", () => {
		for (const kind of ["subsite", "api"] as const) {
			const out = renderAgentAccessReadyEmail({
				...base,
				kind,
				locale: "en-US",
				domain: kind === "subsite" ? "apple.lsrai.shop" : null,
			});
			expect(out.text).toContain(
				"Questions? Use Contact support on your order page.",
			);
			expect(`${out.text}${out.html}`).not.toMatch(
				/WeChat|微信|owner-wechat-qr/,
			);
		}
	});
	it("keeps the owner's WeChat off the order page and public assets", async () => {
		for (const file of [
			"../../src/features/storefront/pages/order.tsx",
			"../../src/features/agent-access/components/access.tsx",
			"../../src/features/notifications/server/fanout.ts",
			"../../messages/zh-CN.json",
		]) {
			const text = await readFile(new URL(file, import.meta.url), "utf8");
			expect(text, file).not.toContain("owner-wechat-qr");
			expect(text, file).not.toContain("agentOwnerWeChat");
			expect(text, file).not.toContain("添加微信");
		}
		expect(
			existsSync(new URL("../../public/owner-wechat-qr.jpg", import.meta.url)),
		).toBe(false);
	});
});
