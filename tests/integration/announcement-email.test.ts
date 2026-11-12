import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleAnnouncementEmailRequest,
	runAnnouncement,
} from "#/features/announcements/server/email";
import { decryptNotificationMessage } from "#/features/notifications/secrets";
import {
	announcementEmailEvent,
	supportReplyEmailSender,
} from "#/features/notifications/server/delivery";
import { recipientHash } from "#/features/notifications/server/recipient-policy";
import { isPublicApiRequest } from "#/server/api-boundaries";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

const token = "synthetic-ops-token-that-is-long-enough";
const content = {
	subject: "【广告】Claude 成品号上新",
	text: "新品上架：https://laoshirenvip.com/products/claude?item=a。退订：{{unsubscribe_url}}",
	html: '<p>新品上架。<a href="https://laoshirenvip.com/products/claude?item=a&amp;x=1">去看看</a> <a href="{{unsubscribe_url}}">退订</a></p>',
};

describe("product announcement email", { timeout: 30000 }, () => {
	let mf: Miniflare;
	let db: D1Database;
	let seq = 0;
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
				`INSERT INTO system_settings(key,value) VALUES ('runtime.data_encryption_secret','"test-access-data-secret-32-characters"'),('runtime.better_auth_url','"https://laoshirenvip.com"')`,
			)
			.run();
		await db
			.prepare(
				"INSERT INTO notification_channel_configs (id,channel,name,provider,from_address,enabled) VALUES ('official','email','Official','cloudflare_email',?,1)",
			)
			.bind(supportReplyEmailSender)
			.run();
		await db
			.prepare(
				"INSERT INTO products (id,name,product_type,status,sort_order,created_at,updated_at) VALUES ('p','P','stock','active',1,0,0)",
			)
			.run();
		await db
			.prepare(
				`INSERT INTO product_sellable_items (id,product_id,name,currency,currency_decimals,price_minor,cost_minor,minimum_quantity,maximum_quantity,sort_order,enabled,created_at,updated_at)
				 VALUES ('s','p','Default','CNY',2,'1000','700',1,1,1,1,0,0)`,
			)
			.run();
		seq = 0;
	}, 30000);
	afterEach(async () => {
		await mf.dispose();
	});

	async function order(
		email: string,
		productName: string,
		options: { paid?: boolean; refunded?: boolean } = {},
	) {
		seq += 1;
		const id = `o${seq}`;
		const paid = options.paid ?? true;
		await db.batch([
			db
				.prepare(
					`INSERT INTO shop_orders (id,order_number,contact_email,normalized_contact_email,status,currency,currency_decimals,subtotal_minor,discount_minor,total_minor,paid_minor,version,expires_at,paid_at,refunded_at,created_at,updated_at)
					 VALUES (?,?,?,?,?,'CNY',2,'1000','0','1000','1000',2,1,?,?,1,1)`,
				)
				.bind(
					id,
					`GM-TEST-${seq}`,
					email,
					email.toLowerCase(),
					options.refunded ? "refunded" : paid ? "completed" : "pending",
					paid ? 1 : null,
					options.refunded ? 2 : null,
				),
			db
				.prepare(
					`INSERT INTO shop_order_items (id,order_id,product_id,sellable_item_id,product_name,delivery_component_id,delivery_component_type,delivery_component_version,sellable_item_name,quantity,unit_price_minor,unit_cost_minor,discount_minor,subtotal_minor,created_at,updated_at)
					 VALUES (?,?,'p','s',?,'s','stock',1,'Default',1,'1000','700','0','1000',1,1)`,
				)
				.bind(`${id}-i`, id, productName),
		]);
		return `${id}-i`;
	}

	async function user(id: string, email: string, roleIds = "[]") {
		await db
			.prepare(
				"INSERT INTO users(id,name,email,email_verified,enabled,balance_minor,balance_version,role_ids) VALUES (?,'U',?,1,1,'0',1,?)",
			)
			.bind(id, email, roleIds)
			.run();
	}

	const deliveries = async () =>
		(
			await db
				.prepare(
					"SELECT id,idempotency_key,channel_config_id,status FROM notification_deliveries WHERE event=? ORDER BY idempotency_key",
				)
				.bind(announcementEmailEvent)
				.all<{
					id: string;
					idempotency_key: string;
					channel_config_id: string;
					status: string;
				}>()
		).results;

	async function seedAudience() {
		await order("Claude1@mail-buyer.cn", "Claude 会员充值");
		await order("claude2@mail-buyer.cn", "Claude 成品号");
		await order("gpt@mail-buyer.cn", "ChatGPT Plus");
		await order("unpaid@mail-buyer.cn", "Claude 成品号", { paid: false });
		await order("refunded@mail-buyer.cn", "Claude 成品号", { refunded: true });
		// Unsubscribed, suppressed, operator-excluded, staff and agent buyers.
		await order("unsub@mail-buyer.cn", "Claude Pro");
		await order("bounce@mail-buyer.cn", "Claude Pro");
		await order("listed@mail-buyer.cn", "Claude Pro");
		await order("staff@mail-buyer.cn", "Claude Pro");
		const agentItem = await order("agent@mail-buyer.cn", "Claude Pro");
		await db
			.prepare(
				"INSERT INTO email_unsubscribes (recipient_hash,scope,created_at) VALUES (?,'renewal',1)",
			)
			.bind(await recipientHash("unsub@mail-buyer.cn"))
			.run();
		await db
			.prepare(
				"INSERT INTO email_recipient_suppressions (recipient_hash,reason,source_delivery_id,created_at) VALUES (?,'hard_bounce','x',1)",
			)
			.bind(await recipientHash("bounce@mail-buyer.cn"))
			.run();
		await db
			.prepare(
				"INSERT INTO roles (id,name,built_in,enabled,permissions_json) VALUES ('r-admin','admin',0,1,'{}')",
			)
			.run();
		await user("u-staff", "Staff@mail-buyer.cn", '["r-admin"]');
		await user("u-agent", "agent@mail-buyer.cn");
		await db
			.prepare(
				"INSERT INTO agent_access_orders (order_item_id,user_id,kind,email,state,created_at,updated_at) VALUES (?,'u-agent','subsite','agent@mail-buyer.cn','active',1,1)",
			)
			.bind(agentItem)
			.run();
	}

	it("dry run counts the audience and exclusions without sending", async () => {
		await seedAudience();
		const result = await runAnnouncement(db, {
			campaignKey: "claude-acct-1112",
			segment: "claude",
			excludeEmails: ["LISTED@mail-buyer.cn"],
			...content,
		});
		expect(result).toMatchObject({
			dryRun: true,
			candidates: 7,
			eligible: 2,
			excluded: {
				unsubscribed: 1,
				suppressed: 1,
				operator_list: 1,
				staff: 1,
				agent: 1,
			},
		});
		expect(await deliveries()).toHaveLength(0);
	});

	it("sends once per campaign and recipient with an unsubscribe link", async () => {
		await seedAudience();
		const input = {
			campaignKey: "claude-acct-1112",
			segment: "claude" as const,
			excludeEmails: ["listed@mail-buyer.cn"],
			dryRun: false,
			...content,
		};
		const first = await runAnnouncement(db, { ...input, limit: 1 });
		expect(first).toMatchObject({ accepted: 1, failed: 0, remaining: 1 });
		const second = await runAnnouncement(db, input);
		expect(second).toMatchObject({
			accepted: 1,
			alreadySent: 1,
			remaining: 0,
		});
		const third = await runAnnouncement(db, input);
		expect(third).toMatchObject({ accepted: 0, alreadySent: 2, eligible: 0 });
		const rows = await deliveries();
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.channel_config_id === "official")).toBe(
			true,
		);
		const secret = (await loadRuntimeConfig(db)).commerceSecret;
		const messages = await Promise.all(
			rows.map(async (row) => {
				const stored = await db
					.prepare(
						"SELECT message_encrypted FROM notification_deliveries WHERE id=?",
					)
					.bind(row.id)
					.first<{ message_encrypted: string }>();
				return JSON.parse(
					await decryptNotificationMessage(
						stored?.message_encrypted ?? "",
						secret,
					),
				);
			}),
		);
		expect(messages.map((m) => m.to).sort()).toEqual([
			"claude1@mail-buyer.cn",
			"claude2@mail-buyer.cn",
		]);
		for (const message of messages) {
			expect(message.from).toBe(supportReplyEmailSender);
			expect(message.text).toContain(
				"https://laoshirenvip.com/unsubscribe/renewal?e=",
			);
			expect(message.text).not.toContain("{{unsubscribe_url}}");
			expect(message.html).toContain("/unsubscribe/renewal?e=");
			expect(message.html).toContain("&amp;sig=");
			// Links to the shop carry the campaign; the unsubscribe link is untouched.
			expect(message.text).toContain(
				"https://laoshirenvip.com/products/claude?item=a&utm_source=announcement&utm_medium=email&utm_campaign=claude-acct-1112。",
			);
			expect(message.html).toContain(
				'href="https://laoshirenvip.com/products/claude?item=a&amp;x=1&amp;utm_source=announcement&amp;utm_medium=email&amp;utm_campaign=claude-acct-1112"',
			);
			expect(message.text).not.toMatch(/unsubscribe\/renewal\?[^\s]*utm_/);
			expect(message.html).not.toMatch(/unsubscribe\/renewal\?[^"]*utm_/);
			expect(message.headers["List-Unsubscribe"]).toContain(
				"/api/shop/renewal/unsubscribe?e=",
			);
		}
	});

	it("second batch to everyone skips the first campaign's recipients", async () => {
		await seedAudience();
		const base = { excludeEmails: ["listed@mail-buyer.cn"], ...content };
		await runAnnouncement(db, {
			campaignKey: "claude-acct-1112",
			segment: "claude",
			dryRun: false,
			...base,
		});
		const all = await runAnnouncement(db, {
			campaignKey: "claude-acct-1112-all",
			segment: "all",
			excludeCampaignKeys: ["claude-acct-1112"],
			...base,
		});
		expect(all).toMatchObject({
			eligible: 1,
			excluded: { exclude_campaign: 2 },
		});
		const bySegment = await runAnnouncement(db, {
			campaignKey: "claude-acct-1112-all",
			segment: "all",
			excludeSegment: "claude",
			...base,
		});
		expect(bySegment).toMatchObject({ eligible: 1 });
	});

	it("requires the unsubscribe placeholder and the ops bearer token", async () => {
		await expect(
			runAnnouncement(db, {
				campaignKey: "claude-acct-1112",
				segment: "claude",
				subject: "x",
				text: "no link",
				html: "<p>no link</p>",
			}),
		).rejects.toThrow();
		const call = (authorization?: string, body: unknown = {}) =>
			handleAnnouncementEmailRequest(
				new Request("https://laoshirenvip.com/api/ops/announcement-email", {
					method: "POST",
					headers: authorization ? { authorization } : {},
					body: JSON.stringify(body),
				}),
				{ DB: db, RESTOCK_API_TOKEN: token },
			);
		expect((await call()).status).toBe(401);
		expect((await call("Bearer wrong")).status).toBe(401);
		expect((await call(`Bearer ${token}`, { segment: "claude" })).status).toBe(
			400,
		);
		await seedAudience();
		const ok = await call(`Bearer ${token}`, {
			campaignKey: "claude-acct-1112",
			segment: "claude",
			...content,
		});
		expect(ok.status).toBe(200);
		expect(await ok.json()).toMatchObject({ ok: true, dryRun: true });
		expect(await deliveries()).toHaveLength(0);
		const route = (method: string) =>
			isPublicApiRequest(
				new Request("https://laoshirenvip.com/api/ops/announcement-email", {
					method,
				}),
			);
		expect(route("POST")).toBe(true);
		expect(route("GET")).toBe(false);
	});
});
