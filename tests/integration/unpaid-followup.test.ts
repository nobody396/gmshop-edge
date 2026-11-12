import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentAccessProducts } from "#/features/agent-access/products";
import { prepareCustomerDataDeletion } from "#/features/customers/server/privacy";
import { decryptNotificationMessage } from "#/features/notifications/secrets";
import { processNotificationDelivery } from "#/features/notifications/server/delivery";
import { recipientHash } from "#/features/notifications/server/recipient-policy";
import { verifyRenewalUnsubscribe } from "#/features/renewals/server/links";
import { identityExclusion } from "#/features/unpaid-followup/server/eligibility";
import { renderUnpaidFollowupEmail } from "#/features/unpaid-followup/server/email";
import {
	handleUnpaidFollowupRequest,
	previewUnpaidFollowups,
} from "#/features/unpaid-followup/server/ops";
import {
	assessUnpaidOrder,
	claimFollowup,
	loadFollowupOrder,
	priceDifferenceProductId,
	runUnpaidOrderFollowups,
} from "#/features/unpaid-followup/server/scheduler";
import {
	loadUnpaidFollowupSettings,
	setUnpaidFollowupEnabled,
} from "#/features/unpaid-followup/server/settings";
import { encryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { applyMigrations } from "./migrations";

const secret = "data-test-secret";
const opsToken = "ops-token-for-tests-0123456789";
const minute = 60_000;
// Absolute instants only (UTC milliseconds): nothing depends on the host timezone.
const activatedAt = Date.parse("2026-11-12T00:00:00Z");
const createdAt = activatedAt + 10 * minute;
const expiresAt = createdAt + 30 * minute;
/** 40 minutes after expiry: inside the 30–60 minute window. */
const sendAt = expiresAt + 40 * minute;

const productId = "6a1f8a52-3f5e-4c1b-9d55-0c7a1e2b3c4d";
const itemId = "7b2e9c63-4a6f-4d2c-8e66-1d8b2f3c4d5e";
const otherItemId = "8c3fad74-5b70-4e3d-9f77-2e9c304d5e6f";

describe("unpaid order follow-up email", { timeout: 120_000 }, () => {
	let miniflare: Miniflare;
	let db: D1Database;

	beforeEach(async () => {
		miniflare = new Miniflare({
			modules: true,
			script: "export default { fetch() { return new Response('ok') } }",
			d1Databases: { DB: crypto.randomUUID() },
		});
		db = await miniflare.getD1Database("DB");
		await applyMigrations(db);
		await seedBase(db);
	}, 120_000);

	afterEach(async () => {
		vi.useRealTimers();
		await miniflare.dispose();
	}, 60_000);

	const followups = async () =>
		(
			await db
				.prepare(
					"SELECT order_id, status, status_reason, usdt_hint FROM unpaid_order_followups ORDER BY order_id",
				)
				.all<{
					order_id: string;
					status: string;
					status_reason: string | null;
					usdt_hint: number;
				}>()
		).results;
	const deliveries = async () =>
		(
			await db
				.prepare(
					"SELECT id, event, idempotency_key, channel_config_id, locale, status, message_encrypted FROM notification_deliveries ORDER BY created_at, id",
				)
				.all<{
					id: string;
					event: string;
					idempotency_key: string;
					channel_config_id: string | null;
					locale: string;
					status: string;
					message_encrypted: string;
				}>()
		).results;
	const message = async (encrypted: string) =>
		JSON.parse(await decryptNotificationMessage(encrypted, secret)) as {
			to: string;
			from: string;
			subject: string;
			text: string;
			headers?: Record<string, string>;
		};

	it("is disabled by default and sends nothing", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@mail-buyer.cn",
			attempt: "usdt",
		});
		expect(await loadUnpaidFollowupSettings(db)).toEqual({
			enabled: false,
			activatedAt: null,
		});
		expect(await runUnpaidOrderFollowups(db, { now: sendAt })).toEqual({
			status: "disabled",
		});
		expect(await followups()).toEqual([]);
		expect(await deliveries()).toEqual([]);
	});

	it("sends one helpful email with the USDT line, tagged links and an intact unsubscribe link", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await seedOrder(db, {
			id: "o1",
			email: "Buyer@Mail-Buyer.cn",
			attempt: "usdt",
		});
		const result = await runUnpaidOrderFollowups(db, { now: sendAt });
		expect(result).toMatchObject({ status: "ran", sent: 1, skipped: 0 });
		const [delivery] = await deliveries();
		expect(delivery).toMatchObject({
			event: "unpaid_order_followup",
			idempotency_key: "unpaid_followup:o1",
			channel_config_id: "cloudflare-email",
			locale: "zh-CN",
			status: "pending",
		});
		const sent = await message(delivery?.message_encrypted ?? "");
		expect(sent.to).toBe("buyer@mail-buyer.cn");
		expect(sent.from).toBe("老实人AI VIP <no-reply@laoshirenvip.com>");
		expect(sent.subject).toBe("你的订单还没完成，需要帮忙吗？");
		const reorder = `https://laoshirenvip.com/products/${productId}?item=${itemId}&utm_source=order_email&utm_medium=email&utm_campaign=unpaid_followup#purchase-options`;
		const support =
			"https://laoshirenvip.com/?utm_source=order_email&utm_medium=email&utm_campaign=unpaid_followup#support";
		const lines = sent.text.split("\n");
		expect(lines.slice(0, 9)).toEqual([
			"你刚才选的「ChatGPT Plus 1个月」还没付款，订单已自动关闭。",
			"",
			"如果是付款时遇到问题：",
			"· 用 USDT 不方便的话，可以换成支付宝，扫码就能付",
			"· 不确定买哪个规格，可以直接问客服",
			"",
			`重新下单：${reorder}`,
			`联系客服：${support}`,
			"",
		]);
		expect(lines[9]).toBe("—— 老实人AI VIP");
		const unsubscribeLine = lines.at(-1) ?? "";
		expect(unsubscribeLine).toMatch(
			/^不想再收到这类邮件？退订：https:\/\/laoshirenvip\.com\/unsubscribe\/renewal\?e=/,
		);
		const unsubscribe = new URL(
			unsubscribeLine.slice(unsubscribeLine.indexOf("https://")),
		);
		expect([...unsubscribe.searchParams.keys()]).toEqual(["e", "sig"]);
		const runtime = await loadRuntimeConfig(db);
		expect(
			await verifyRenewalUnsubscribe(
				runtime,
				unsubscribe.searchParams.get("e"),
				unsubscribe.searchParams.get("sig"),
			),
		).toBe(true);
		expect(sent.headers?.["List-Unsubscribe"]).toMatch(
			/^<https:\/\/laoshirenvip\.com\/api\/shop\/renewal\/unsubscribe\?e=/,
		);
		expect(sent.headers?.["List-Unsubscribe-Post"]).toBe(
			"List-Unsubscribe=One-Click",
		);
		// No discount, coupon or urgency wording.
		expect(sent.text).not.toMatch(/优惠|折|券|立减|尽快|马上|限时/);
		expect(await followups()).toEqual([
			{ order_id: "o1", status: "sent", status_reason: null, usdt_hint: 1 },
		]);
	});

	it("never sends twice: reruns and an unfinished claim settle from the delivery row", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await seedOrder(db, {
			id: "o1",
			email: "buyer@mail-buyer.cn",
			attempt: "usdt",
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		expect(
			await runUnpaidOrderFollowups(db, { now: sendAt + minute }),
		).toMatchObject({ sent: 0, skipped: 0 });
		// Enqueued, but the claim was never finalized (crash before the UPDATE).
		await db
			.prepare(
				"UPDATE unpaid_order_followups SET status = 'sending', notification_delivery_id = NULL, sent_at = NULL, updated_at = ?",
			)
			.bind(sendAt)
			.run();
		// A second abandoned order from the same address becomes due meanwhile.
		await seedOrder(db, {
			id: "o2",
			email: "buyer@mail-buyer.cn",
			attempt: "usdt",
			createdAt: createdAt + 16 * minute,
		});
		const later = await runUnpaidOrderFollowups(db, {
			now: sendAt + 16 * minute,
		});
		expect(later).toMatchObject({ recovered: 1, sent: 0, skipped: 1 });
		const rows = await deliveries();
		expect(rows).toHaveLength(1);
		expect(await followups()).toEqual([
			{ order_id: "o1", status: "sent", status_reason: null, usdt_hint: 1 },
			{
				order_id: "o2",
				status: "skipped",
				status_reason: "recent_followup",
				usdt_hint: 0,
			},
		]);
		const settled = await db
			.prepare(
				"SELECT notification_delivery_id FROM unpaid_order_followups WHERE order_id = 'o1'",
			)
			.first<{ notification_delivery_id: string }>();
		expect(settled?.notification_delivery_id).toBe(rows[0]?.id);
	});

	it("a failed enqueue keeps the claim and the recipient's cooldown", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await db
			.prepare(
				"CREATE TRIGGER fail_delivery BEFORE INSERT ON notification_deliveries BEGIN SELECT RAISE(ABORT, 'storage down'); END",
			)
			.run();
		await seedOrder(db, {
			id: "o1",
			email: "buyer@mail-buyer.cn",
			attempt: "usdt",
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		expect(await followups()).toEqual([
			{
				order_id: "o1",
				status: "failed",
				status_reason: "enqueue_failed",
				usdt_hint: 1,
			},
		]);
		await db.prepare("DROP TRIGGER fail_delivery").run();
		await seedOrder(db, {
			id: "o2",
			email: "buyer@mail-buyer.cn",
			attempt: "usdt",
			createdAt: createdAt + 10 * minute,
		});
		await runUnpaidOrderFollowups(db, { now: sendAt + 10 * minute });
		expect(
			(await followups()).find((row) => row.order_id === "o2"),
		).toMatchObject({
			status: "skipped",
			status_reason: "recent_followup",
		});
		expect(await deliveries()).toEqual([]);
	});

	it("claims are atomic per address: overlapping runs cannot take two orders for one email", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await seedOrder(db, {
			id: "o1",
			email: "race@mail-buyer.cn",
			attempt: "usdt",
		});
		await seedOrder(db, {
			id: "o2",
			email: "race@mail-buyer.cn",
			attempt: "usdt",
		});
		const assess = async (id: string) => {
			const order = await loadFollowupOrder(db, { id });
			if (!order) throw new Error("missing order");
			return assessUnpaidOrder(db, order, sendAt);
		};
		// Both runs assessed before either claimed: both look eligible.
		const [a, b] = await Promise.all([assess("o1"), assess("o2")]);
		expect([a.eligible, b.eligible]).toEqual([true, true]);
		const hash = await recipientHash("race@mail-buyer.cn");
		const claims = await Promise.all([
			claimFollowup(db, a, hash, activatedAt, sendAt),
			claimFollowup(db, b, hash, activatedAt, sendAt),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const reservation = await db
			.prepare("SELECT COUNT(*) AS n FROM unpaid_followup_recipients")
			.first<{ n: number }>();
		expect(reservation?.n).toBe(1);
		expect(
			(await followups()).filter((row) => row.status === "sending"),
		).toHaveLength(1);
		// A reservation older than 30 days is taken over.
		await db
			.prepare("UPDATE unpaid_followup_recipients SET reserved_at = ?")
			.bind(sendAt - 31 * 86_400_000)
			.run();
		await seedOrder(db, {
			id: "o3",
			email: "race@mail-buyer.cn",
			attempt: "usdt",
		});
		const c = await assess("o3");
		expect(c.eligible).toBe(true);
		expect(await claimFollowup(db, c, hash, activatedAt, sendAt)).toBe(true);
	});

	it("re-checks eligibility right before the provider and cancels queued emails", async () => {
		const sent: unknown[] = [];
		const binding = {
			send: async (value: unknown) => {
				sent.push(value);
				return { messageId: "mock" };
			},
		} as unknown as SendEmail;
		const deliver = async (orderId: string) => {
			const row = await db
				.prepare(
					"SELECT id FROM notification_deliveries WHERE idempotency_key = ?",
				)
				.bind(`unpaid_followup:${orderId}`)
				.first<{ id: string }>();
			return processNotificationDelivery(db, row?.id ?? "", {
				cloudflareEmail: binding,
			});
		};
		const reasonOf = async (orderId: string) =>
			(await followups()).find((row) => row.order_id === orderId);
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		// The delivery path reads the real clock; pin only Date to the test timeline.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(sendAt + 2 * minute);
		for (const id of [
			"o-ok",
			"o-paid",
			"o-bought",
			"o-unsub",
			"o-stale",
			"o-off",
		])
			await seedOrder(db, {
				id,
				email: `${id}@mail-buyer.cn`,
				attempt: "usdt",
			});
		await runUnpaidOrderFollowups(db, { now: sendAt, d1Budget: 1_000 });
		expect(await deliveries()).toHaveLength(6);
		// After queueing: the order got paid late, the address bought another
		// order, and another address unsubscribed.
		await db
			.prepare(
				"UPDATE shop_orders SET status = 'paid', paid_at = ?, paid_minor = total_minor WHERE id = 'o-paid'",
			)
			.bind(sendAt + minute)
			.run();
		await seedOrder(db, {
			id: "x-bought",
			email: "o-bought@mail-buyer.cn",
			status: "completed",
			paidAt: sendAt + minute,
			createdAt: sendAt,
		});
		await db
			.prepare(
				"INSERT INTO email_unsubscribes (recipient_hash, scope, created_at) VALUES (?, 'renewal', 1)",
			)
			.bind(await recipientHash("o-unsub@mail-buyer.cn"))
			.run();
		await expect(deliver("o-ok")).resolves.toMatchObject({
			status: "accepted",
		});
		for (const [id, reason] of [
			["o-paid", "paid"],
			["o-bought", "paid_later"],
			["o-unsub", "unsubscribed"],
		] as const) {
			await expect(deliver(id)).resolves.toMatchObject({
				status: "suppressed",
			});
			expect(await reasonOf(id)).toMatchObject({
				status: "cancelled",
				status_reason: reason,
			});
		}
		// Queue stalled for hours: "just now" is no longer true.
		vi.setSystemTime(expiresAt + 4 * 3_600_000);
		await expect(deliver("o-stale")).resolves.toMatchObject({
			status: "suppressed",
		});
		expect(await reasonOf("o-stale")).toMatchObject({
			status: "cancelled",
			status_reason: "stale",
		});
		vi.setSystemTime(sendAt + 4 * minute);
		// Switched off, then on again (a new activation generation): the queued
		// email from the earlier generation is cancelled, not sent.
		await setUnpaidFollowupEnabled(db, false, sendAt + 2 * minute);
		await setUnpaidFollowupEnabled(db, true, sendAt + 3 * minute);
		await expect(deliver("o-off")).resolves.toMatchObject({
			status: "suppressed",
		});
		expect(await reasonOf("o-off")).toMatchObject({
			status: "cancelled",
			status_reason: "disabled",
		});
		expect(sent).toHaveLength(1);
		const codes = await db
			.prepare(
				"SELECT error_code FROM notification_deliveries WHERE status = 'suppressed' ORDER BY error_code",
			)
			.all<{ error_code: string }>();
		expect(codes.results.map((row) => row.error_code)).toEqual([
			"unpaid_followup_disabled",
			"unpaid_followup_paid",
			"unpaid_followup_paid_later",
			"unpaid_followup_stale",
			"unpaid_followup_unsubscribed",
		]);
		// A retry of an accepted email does not send again.
		await expect(deliver("o-ok")).resolves.toMatchObject({ duplicate: true });
		expect(sent).toHaveLength(1);
	});

	it("omits the USDT line when the attempt was Alipay or no Alipay channel can take the order", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await seedOrder(db, {
			id: "o-alipay",
			email: "a@mail-buyer.cn",
			attempt: "alipay",
		});
		await seedOrder(db, {
			id: "o-none",
			email: "n@mail-buyer.cn",
			attempt: null,
		});
		await seedOrder(db, {
			id: "o-priced-usdt",
			email: "p@mail-buyer.cn",
			attempt: null,
			pricingChannelId: "ch-usdt",
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		expect(
			Object.fromEntries(
				(await followups()).map((row) => [row.order_id, row.usdt_hint]),
			),
		).toEqual({ "o-alipay": 0, "o-none": 0, "o-priced-usdt": 1 });
		for (const row of await deliveries()) {
			const sent = await message(row.message_encrypted);
			if (row.idempotency_key === "unpaid_followup:o-priced-usdt")
				expect(sent.text).toContain("USDT");
			else expect(sent.text).not.toContain("USDT");
		}
		// USDT attempt, but Alipay is switched off: no line suggesting it.
		await db
			.prepare("UPDATE payment_channels SET enabled = 0 WHERE id = 'ch-alipay'")
			.run();
		await seedOrder(db, {
			id: "o-usdt",
			email: "u@mail-buyer.cn",
			attempt: "usdt",
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		const usdt = (await followups()).find((row) => row.order_id === "o-usdt");
		expect(usdt).toMatchObject({ status: "sent", usdt_hint: 0 });
	});

	it("respects the Alipay QR per-payment limit when deciding the USDT line", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await db.batch([
			db.prepare(
				"UPDATE payment_channels SET enabled = 0 WHERE id = 'ch-alipay'",
			),
			db.prepare(
				`INSERT INTO payment_channels (id, name, provider, currency, enabled, per_payment_max_minor)
				 VALUES ('ch-qr', '支付宝扫码', 'alipay_qr', 'CNY', 1, '5000')`,
			),
			db
				.prepare(
					"UPDATE product_sellable_items SET price_minor = '4000' WHERE id = ?",
				)
				.bind(itemId),
			db
				.prepare(
					"UPDATE product_sellable_items SET price_minor = '9000' WHERE id = ?",
				)
				.bind(otherItemId),
		]);
		await seedOrder(db, {
			id: "o-small",
			email: "s@mail-buyer.cn",
			attempt: "usdt",
			priceMinor: "4000",
		});
		await seedOrder(db, {
			id: "o-large",
			email: "l@mail-buyer.cn",
			attempt: "usdt",
			priceMinor: "9000",
			itemId: otherItemId,
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		expect(
			Object.fromEntries(
				(await followups()).map((row) => [row.order_id, row.usdt_hint]),
			),
		).toEqual({ "o-large": 0, "o-small": 1 });
	});

	it("quotes Alipay like checkout does: channel fees count against the QR cap", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await db.batch([
			db.prepare(
				"UPDATE payment_channels SET enabled = 0 WHERE id = 'ch-alipay'",
			),
			// 5000 cap, 1% fee: goods of 5000 cost 5051 at checkout, 4900 cost 4950.
			db.prepare(
				`INSERT INTO payment_channels (id, name, provider, currency, enabled, per_payment_max_minor, fee_bps)
				 VALUES ('ch-qr', '支付宝扫码', 'alipay_qr', 'CNY', 1, '5000', 100)`,
			),
			db
				.prepare(
					"UPDATE product_sellable_items SET price_minor = '5000' WHERE id = ?",
				)
				.bind(itemId),
			db
				.prepare(
					"UPDATE product_sellable_items SET price_minor = '4900' WHERE id = ?",
				)
				.bind(otherItemId),
		]);
		await seedOrder(db, {
			id: "o-at-cap",
			email: "cap@mail-buyer.cn",
			attempt: "usdt",
			priceMinor: "5000",
		});
		await seedOrder(db, {
			id: "o-under",
			email: "under@mail-buyer.cn",
			attempt: "usdt",
			priceMinor: "4900",
			itemId: otherItemId,
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		expect(
			Object.fromEntries(
				(await followups()).map((row) => [row.order_id, row.usdt_hint]),
			),
		).toEqual({ "o-at-cap": 0, "o-under": 1 });
	});

	it("does not advertise Alipay through an EPay channel configured for WeChat Pay", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await db
			.prepare(
				"UPDATE payment_channels SET credential_encrypted = ? WHERE id = 'ch-alipay'",
			)
			.bind(await epayCredential("wxpay"))
			.run();
		await seedOrder(db, {
			id: "o-wx",
			email: "wx@mail-buyer.cn",
			attempt: "usdt",
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		expect(await followups()).toEqual([
			{ order_id: "o-wx", status: "sent", status_reason: null, usdt_hint: 0 },
		]);
		const [delivery] = await deliveries();
		expect(
			(await message(delivery?.message_encrypted ?? "")).text,
		).not.toContain("支付宝");
	});

	it("identity checks are index-backed (no per-minute table scans)", async () => {
		const sql = (await import("node:fs")).readFileSync(
			new URL(
				"../../src/features/unpaid-followup/server/eligibility.ts",
				import.meta.url,
			),
			"utf8",
		);
		const query = /`(WITH identity AS[\s\S]*?AS agent)`/.exec(sql)?.[1];
		expect(query).toBeTruthy();
		const plan = await db
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.bind("u-1", "a@mail-buyer.cn", "a@mail-buyer.cn")
			.all<{ detail: string }>();
		const details = plan.results.map((row) => row.detail).join("\n");
		expect(details).not.toMatch(
			/SCAN (users|aa|agent_access_orders|k|au|supplier_api)/,
		);
		expect(details).toMatch(/users_lower_email_idx/);
		expect(details).toMatch(/agent_access_orders_email_idx/);
		expect(await identityExclusion(db, null, "a@mail-buyer.cn")).toBeNull();
	});

	it("only treats Cryptomus as USDT when the channel says so", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await db
			.prepare(
				`INSERT INTO payment_channels (id, name, provider, currency, enabled, default_token, default_network)
				 VALUES ('ch-btc', 'Crypto', 'cryptomus', 'CNY', 1, 'BTC', 'BTC'),
				        ('ch-any', 'Crypto (any coin)', 'cryptomus', 'CNY', 1, '', ''),
				        ('ch-cusdt', 'Crypto USDT', 'cryptomus', 'CNY', 1, 'USDT', 'TRC20')`,
			)
			.run();
		for (const [id, channel] of [
			["o-btc", "ch-btc"],
			["o-any", "ch-any"],
			["o-cusdt", "ch-cusdt"],
		] as const)
			await seedOrder(db, {
				id,
				email: `${id}@mail-buyer.cn`,
				attempt: null,
				pricingChannelId: channel,
			});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		expect(
			Object.fromEntries(
				(await followups()).map((row) => [row.order_id, row.usdt_hint]),
			),
		).toEqual({ "o-any": 0, "o-btc": 0, "o-cusdt": 1 });
	});

	it("customer data deletion stops queued follow-ups and keeps the orders unclaimable", async () => {
		const sent: unknown[] = [];
		const binding = {
			send: async (value: unknown) => {
				sent.push(value);
				return { messageId: "mock" };
			},
		} as unknown as SendEmail;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(sendAt + 2 * minute);
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await seedOrder(db, {
			id: "o1",
			email: "gone@mail-buyer.cn",
			attempt: "usdt",
		});
		// Same guest, a second abandoned order that is not due yet.
		await seedOrder(db, {
			id: "o2",
			email: "gone@mail-buyer.cn",
			attempt: "usdt",
			createdAt: createdAt + 16 * minute,
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		const [queued] = await deliveries();
		expect(queued?.status).toBe("pending");
		const deletion = await prepareCustomerDataDeletion(
			db,
			"o1",
			sendAt + minute,
		);
		await db.batch(deletion.statements);
		await db
			.prepare(
				"INSERT INTO email_unsubscribes (recipient_hash, scope, created_at) VALUES (?, 'renewal', 1)",
			)
			.bind(await recipientHash("gone@mail-buyer.cn"))
			.run();
		await runUnpaidOrderFollowups(db, { now: sendAt + 16 * minute });
		const hashes = await db
			.prepare(
				"SELECT order_id, recipient_hash FROM unpaid_order_followups ORDER BY order_id",
			)
			.all<{ order_id: string; recipient_hash: string | null }>();
		expect(hashes.results).toEqual([
			{ order_id: "o1", recipient_hash: null },
			{ order_id: "o2", recipient_hash: null },
		]);
		expect(await followups()).toEqual([
			{
				order_id: "o1",
				status: "cancelled",
				status_reason: "customer_deleted",
				usdt_hint: 1,
			},
			{
				order_id: "o2",
				status: "skipped",
				status_reason: "customer_deleted",
				usdt_hint: 0,
			},
		]);
		// Even without the tombstone, the anonymized order is never claimed again.
		await db
			.prepare("DELETE FROM unpaid_order_followups WHERE order_id = 'o1'")
			.run();
		await runUnpaidOrderFollowups(db, { now: sendAt + 17 * minute });
		expect(
			(await followups()).find((row) => row.order_id === "o1"),
		).toMatchObject({
			status: "skipped",
			status_reason: "customer_deleted",
		});
		const rows = await deliveries();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ status: "suppressed" });
		const code = await db
			.prepare("SELECT error_code FROM notification_deliveries")
			.first<{ error_code: string }>();
		expect(code?.error_code).toBe("unpaid_followup_customer_deleted");
		await expect(
			processNotificationDelivery(db, rows[0]?.id ?? "", {
				cloudflareEmail: binding,
			}),
		).resolves.toMatchObject({ status: "suppressed" });
		expect(sent).toEqual([]);
	});

	it("the send-time guard refuses a queued message whose recipient no longer matches the order", async () => {
		const sent: unknown[] = [];
		const binding = {
			send: async (value: unknown) => {
				sent.push(value);
				return { messageId: "mock" };
			},
		} as unknown as SendEmail;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(sendAt + 2 * minute);
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await seedOrder(db, {
			id: "o1",
			email: "first@mail-buyer.cn",
			attempt: "usdt",
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		await db
			.prepare(
				"UPDATE shop_orders SET contact_email = 'second@mail-buyer.cn', normalized_contact_email = 'second@mail-buyer.cn' WHERE id = 'o1'",
			)
			.run();
		const [queued] = await deliveries();
		await expect(
			processNotificationDelivery(db, queued?.id ?? "", {
				cloudflareEmail: binding,
			}),
		).resolves.toMatchObject({ status: "suppressed" });
		expect(await followups()).toEqual([
			{
				order_id: "o1",
				status: "cancelled",
				status_reason: "recipient_changed",
				usdt_hint: 1,
			},
		]);
		expect(sent).toEqual([]);
	});

	it("renders the English version from the order locale", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await seedOrder(db, {
			id: "o1",
			email: "en@mail-buyer.cn",
			attempt: "usdt",
			locale: "en-US",
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		const [delivery] = await deliveries();
		expect(delivery?.locale).toBe("en-US");
		const sent = await message(delivery?.message_encrypted ?? "");
		expect(sent.subject).toBe("Your order isn't finished yet. Need a hand?");
		expect(sent.text).toContain(
			"You picked “ChatGPT Plus 1个月” a little while ago",
		);
		expect(sent.text).toContain(
			"If USDT isn't convenient, you can pay with Alipay",
		);
		expect(sent.text).toContain(
			"Order again: https://laoshirenvip.com/products/",
		);
		expect(sent.text).toContain(
			"Don't want emails like this? Unsubscribe: https://laoshirenvip.com/unsubscribe/renewal?e=",
		);
	});

	it("only emails orders created after activation, 30–60 minutes after they expired", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		// Created one minute before the switch was turned on.
		await seedOrder(db, {
			id: "o-before",
			email: "before@mail-buyer.cn",
			attempt: "usdt",
			createdAt: activatedAt - minute,
		});
		await seedOrder(db, {
			id: "o-early",
			email: "early@mail-buyer.cn",
			attempt: "usdt",
			createdAt: createdAt + 25 * minute,
		});
		await seedOrder(db, {
			id: "o-late",
			email: "late@mail-buyer.cn",
			attempt: "usdt",
			createdAt: createdAt - 25 * minute,
		});
		await seedOrder(db, {
			id: "o-open",
			email: "open@mail-buyer.cn",
			attempt: "usdt",
			status: "pending_payment",
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		expect(await followups()).toEqual([]);
		expect(await deliveries()).toEqual([]);
		// The early one becomes due later; the pre-activation one never does.
		await runUnpaidOrderFollowups(db, { now: sendAt + 25 * minute });
		expect((await followups()).map((row) => row.order_id)).toEqual(["o-early"]);
		const preview = await previewUnpaidFollowups(
			db,
			{ orderNumber: "ORDER-O-BEFORE" },
			sendAt,
		);
		expect(preview.orders[0]).toMatchObject({
			timing: "before_activation",
			wouldSendNow: false,
		});
	});

	it("re-enabling moves the activation cutoff forward; a plain re-save of the flag does too", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await setUnpaidFollowupEnabled(db, false, activatedAt + minute);
		expect((await loadUnpaidFollowupSettings(db)).enabled).toBe(false);
		await setUnpaidFollowupEnabled(db, true, activatedAt + 20 * minute);
		await seedOrder(db, {
			id: "o1",
			email: "buyer@mail-buyer.cn",
			attempt: "usdt",
		});
		await runUnpaidOrderFollowups(db, { now: sendAt });
		expect(await followups()).toEqual([]);
		// Flag written by another path (admin settings / SQL) without the activation key.
		await db
			.prepare(
				"UPDATE system_settings SET value = 'true', updated_at = ? WHERE key = 'notifications.unpaid_followup_enabled'",
			)
			.bind(createdAt + minute)
			.run();
		await db
			.prepare(
				"DELETE FROM system_settings WHERE key = 'notifications.unpaid_followup_activated_at'",
			)
			.run();
		expect(await loadUnpaidFollowupSettings(db)).toEqual({
			enabled: true,
			activatedAt: createdAt + minute,
		});
	});

	it("applies every skip rule", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await db.batch([
			db.prepare(
				"INSERT INTO roles (id,name,built_in,enabled,permissions_json,created_at,updated_at) VALUES ('r-admin','admin',0,1,'{}',1,1)",
			),
			db.prepare(
				`INSERT INTO users (id, name, email, email_verified, enabled, role_ids)
				 VALUES ('u-staff','Staff','staff@mail-buyer.cn',1,1,'["r-admin"]'),
				        ('u-agent','Agent','agent@mail-buyer.cn',1,1,'[]'),
				        ('u-reseller','Reseller','reseller@mail-buyer.cn',1,1,'[]'),
				        ('u-allow','Allowed','allow@mail-buyer.cn',1,1,'[]')`,
			),
			db.prepare(
				"INSERT INTO supplier_api_allowed_users (user_id, created_at, updated_at) VALUES ('u-allow',1,1)",
			),
			db.prepare(
				"INSERT INTO supplier_api_keys (id, user_id, name, key_id, secret_encrypted, created_at, updated_at) VALUES ('key-1','u-reseller','Main','kid','enc',1,1)",
			),
		]);
		const cases: Array<[string, Omit<SeedOrder, "id">, string]> = [
			["o-paid-later", { email: "later@mail-buyer.cn" }, "paid_later"],
			["o-existing", { email: "old@mail-buyer.cn" }, "existing_customer"],
			[
				"o-account-existing",
				{ email: "acct@mail-buyer.cn", userId: "u-acct" },
				"existing_customer",
			],
			["o-recent", { email: "recent@mail-buyer.cn" }, "recent_followup"],
			["o-staff", { email: "staff@mail-buyer.cn" }, "staff"],
			["o-agent", { email: "agent@mail-buyer.cn" }, "agent"],
			[
				"o-reseller",
				{ email: "reseller@mail-buyer.cn", userId: "u-reseller" },
				"agent",
			],
			// Allowlisted agent checking out as a guest with the account email.
			["o-allowlisted-guest", { email: "Allow@Mail-Buyer.cn" }, "agent"],
			["o-api", { email: "api@mail-buyer.cn" }, "agent_api_order"],
			[
				"o-agent-access",
				{ email: "aa@mail-buyer.cn", product: "agent" },
				"agent_access_order",
			],
			[
				"o-upgrade",
				{ email: "up@mail-buyer.cn", product: "upgrade" },
				"upgrade_order",
			],
			[
				"o-diff",
				{ email: "diff@mail-buyer.cn", product: "difference" },
				"upgrade_order",
			],
			[
				"o-test-item",
				{ email: "ti@mail-buyer.cn", product: "test" },
				"test_item",
			],
			["o-test-email", { email: "qa@example.com" }, "test_email"],
			["o-unsub", { email: "unsub@mail-buyer.cn" }, "unsubscribed"],
			["o-suppressed", { email: "bounce@mail-buyer.cn" }, "suppressed"],
			[
				"o-unavailable",
				{ email: "gone@mail-buyer.cn", itemId: otherItemId },
				"item_unavailable",
			],
			[
				"o-partly-paid",
				{ email: "part@mail-buyer.cn", paidMinor: "100" },
				"paid",
			],
		];
		await db
			.prepare(
				"INSERT INTO users (id, name, email, email_verified, enabled) VALUES ('u-acct','Acct','acct-login@mail-buyer.cn',1,1)",
			)
			.run();
		for (const [id, input] of cases)
			await seedOrder(db, { attempt: "usdt", ...input, id });
		// Context for each rule.
		await seedOrder(db, {
			id: "x-paid-later",
			email: "later@mail-buyer.cn",
			status: "completed",
			paidAt: createdAt + 5 * minute,
			createdAt: createdAt + 4 * minute,
		});
		await seedOrder(db, {
			id: "x-existing",
			email: "old@mail-buyer.cn",
			status: "completed",
			paidAt: activatedAt - 30 * 86_400_000,
			createdAt: activatedAt - 30 * 86_400_000,
		});
		await seedOrder(db, {
			id: "x-account",
			email: "other@mail-buyer.cn",
			userId: "u-acct",
			status: "completed",
			paidAt: activatedAt - 86_400_000,
			createdAt: activatedAt - 86_400_000,
		});
		await seedOrder(db, {
			id: "x-recent",
			email: "recent@mail-buyer.cn",
			createdAt: activatedAt - 86_400_000,
		});
		await db.batch([
			db
				.prepare(
					`INSERT INTO unpaid_followup_recipients (recipient_hash, order_id, reserved_at)
					 VALUES (?, 'x-recent', ?)`,
				)
				.bind(
					await recipientHash("recent@mail-buyer.cn"),
					sendAt - 29 * 86_400_000,
				),
			db.prepare(
				"INSERT INTO agent_access_orders (order_item_id,user_id,kind,email,state,created_at,updated_at) VALUES ('x-paid-later-item','u-agent','subsite','Agent@Mail-Buyer.cn','active',1,1)",
			),
			db.prepare(
				"INSERT INTO supplier_api_orders (id, shop_order_id, user_id, api_key_id, downstream_order_no, request_digest, created_at, updated_at) VALUES ('sa-1','o-api','u-reseller','key-1','DS-1','digest',1,1)",
			),
			db.prepare(
				"INSERT INTO gpt_upgrade_orders (order_item_id, quote_id, quote_token_encrypted, price_minor, created_at, updated_at) VALUES ('o-upgrade-item','q-1','enc','100',1,1)",
			),
			db
				.prepare(
					"INSERT INTO email_unsubscribes (recipient_hash, scope, created_at) VALUES (?, 'renewal', 1)",
				)
				.bind(await recipientHash("unsub@mail-buyer.cn")),
			db
				.prepare(
					"INSERT INTO email_recipient_suppressions (recipient_hash, reason, source_delivery_id, created_at) VALUES (?, 'hard_bounce', 'd-1', 1)",
				)
				.bind(await recipientHash("bounce@mail-buyer.cn")),
			db.prepare(
				`UPDATE product_sellable_items SET sale_disabled = 1 WHERE id = '${otherItemId}'`,
			),
		]);
		const result = await runUnpaidOrderFollowups(db, {
			now: sendAt,
			limit: 50,
			d1Budget: 1_000,
		});
		expect(result).toMatchObject({ status: "ran", sent: 0 });
		const decided = Object.fromEntries(
			(await followups())
				.filter((row) => row.order_id.startsWith("o-"))
				.map((row) => [row.order_id, `${row.status}:${row.status_reason}`]),
		);
		expect(decided).toEqual(
			Object.fromEntries(
				cases.map(([id, , reason]) => [id, `skipped:${reason}`]),
			),
		);
		expect(await deliveries()).toEqual([]);
	});

	it("sends only one email when the same address abandons two orders", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await seedOrder(db, {
			id: "o1",
			email: "twice@mail-buyer.cn",
			attempt: "usdt",
		});
		await seedOrder(db, {
			id: "o2",
			email: "twice@mail-buyer.cn",
			attempt: "usdt",
			createdAt: createdAt + minute,
		});
		await runUnpaidOrderFollowups(db, { now: sendAt + minute });
		expect(await followups()).toEqual([
			{ order_id: "o1", status: "sent", status_reason: null, usdt_hint: 1 },
			{
				order_id: "o2",
				status: "skipped",
				status_reason: "recent_followup",
				usdt_hint: 0,
			},
		]);
		expect(await deliveries()).toHaveLength(1);
	});

	it("does nothing without the approved Cloudflare sender", async () => {
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		await db
			.prepare(
				"UPDATE notification_channel_configs SET from_address = '老实人AI <no-reply@laoshirenai.com>'",
			)
			.run();
		await seedOrder(db, {
			id: "o1",
			email: "buyer@mail-buyer.cn",
			attempt: "usdt",
		});
		expect(await runUnpaidOrderFollowups(db, { now: sendAt })).toEqual({
			status: "sender_unavailable",
		});
		expect(await followups()).toEqual([]);
		expect(await deliveries()).toEqual([]);
	});

	it("dry run renders the email for an order and current candidates without sending", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@mail-buyer.cn",
			attempt: "usdt",
		});
		// Disabled: preview still renders the exact email but would not send it.
		const byNumber = await previewUnpaidFollowups(
			db,
			{ orderNumber: "ORDER-O1" },
			sendAt,
		);
		expect(byNumber).toMatchObject({
			dryRun: true,
			enabled: false,
			senderReady: true,
		});
		expect(byNumber.orders[0]).toMatchObject({
			orderNumber: "ORDER-O1",
			email: "buyer@mail-buyer.cn",
			eligibleByRules: true,
			usdtHint: true,
			timing: "disabled",
			wouldSendNow: false,
			rendered: { subject: "你的订单还没完成，需要帮忙吗？" },
		});
		expect(byNumber.orders[0]?.rendered?.text).toContain(
			"· 用 USDT 不方便的话",
		);
		await setUnpaidFollowupEnabled(db, true, activatedAt);
		const current = await previewUnpaidFollowups(db, {}, sendAt);
		expect(current.orders).toHaveLength(1);
		expect(current.orders[0]).toMatchObject({
			timing: "due",
			wouldSendNow: true,
		});
		expect(await followups()).toEqual([]);
		expect(await deliveries()).toEqual([]);
	});

	it("ops endpoint: bearer token, dry-run preview, switch with activation time", async () => {
		await seedOrder(db, {
			id: "o1",
			email: "buyer@mail-buyer.cn",
			attempt: "usdt",
		});
		const env = { DB: db, RESTOCK_API_TOKEN: opsToken };
		const call = (body: unknown, token = opsToken, now = sendAt) =>
			handleUnpaidFollowupRequest(
				new Request("https://laoshirenvip.com/api/ops/unpaid-followup", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				}),
				env,
				now,
			);
		expect((await call({}, "wrong")).status).toBe(401);
		const preview = await call({ orderNumber: "ORDER-O1" });
		expect(preview.status).toBe(200);
		expect(await preview.json()).toMatchObject({
			ok: true,
			dryRun: true,
			orders: [{ orderNumber: "ORDER-O1", wouldSendNow: false }],
		});
		expect(await deliveries()).toEqual([]);
		const enabled = await call({ action: "enable" }, opsToken, activatedAt);
		expect(await enabled.json()).toEqual({
			ok: true,
			settingKey: "notifications.unpaid_followup_enabled",
			enabled: true,
			activatedAt: new Date(activatedAt).toISOString(),
		});
		// Enabling again keeps the original activation time.
		await call({ action: "enable" }, opsToken, activatedAt + 5 * minute);
		expect((await loadUnpaidFollowupSettings(db)).activatedAt).toBe(
			activatedAt,
		);
		const status = await call({ action: "status" });
		expect(await status.json()).toMatchObject({
			enabled: true,
			senderReady: true,
			last30Days: [],
		});
		const disabled = await call({ action: "disable" }, opsToken, sendAt);
		expect(await disabled.json()).toMatchObject({
			enabled: false,
			activatedAt: null,
		});
		expect((await call({ action: "nope" })).status).toBe(400);
	});

	it("renders without the USDT line when not asked to", () => {
		const content = renderUnpaidFollowupEmail({
			locale: "zh-CN",
			itemName: "Claude Pro 1个月",
			usdtHint: false,
			reorderUrl: "https://laoshirenvip.com/products/p?item=i",
			supportUrl: "https://laoshirenvip.com/#support",
			unsubscribeUrl:
				"https://laoshirenvip.com/unsubscribe/renewal?e=a%40b.cn&sig=x",
			brand: "老实人AI VIP",
		});
		expect(content.text).not.toContain("USDT");
		expect(content.text.split("\n").slice(2, 4)).toEqual([
			"如果是付款时遇到问题：",
			"· 不确定买哪个规格，可以直接问客服",
		]);
	});
});

async function seedBase(db: D1Database) {
	await db.batch([
		...[
			["runtime.better_auth_url", '"https://laoshirenvip.com"', 0],
			["runtime.data_encryption_secret", `"${secret}"`, 1],
			["runtime.better_auth_secret", '"auth-test-secret-0123456789abcdef"', 1],
			["site.name", '"老实人AI VIP"', 0],
		].map(([key, value, isSecret]) =>
			db
				.prepare(
					"INSERT INTO system_settings (key, value, is_secret, created_at, updated_at) VALUES (?, ?, ?, 1, 1)",
				)
				.bind(key, value, isSecret),
		),
		db.prepare(
			`INSERT INTO notification_channel_configs
			 (id, channel, name, provider, api_key_encrypted, api_key_version,
			  from_address, reply_to, sort_order, enabled, created_at, updated_at)
			 VALUES ('cloudflare-email', 'email', 'Cloudflare Email', 'cloudflare_email',
			  NULL, NULL, '老实人AI VIP <no-reply@laoshirenvip.com>', NULL, 10, 1, 1, 1)`,
		),
		db.prepare(
			`INSERT INTO payment_channels (id, name, provider, currency, enabled, default_token, default_network)
			 VALUES ('ch-usdt', 'USDT', 'gmpay', 'CNY', 1, 'USDT', 'TRC20')`,
		),
		db
			.prepare(
				`INSERT INTO payment_channels (id, name, provider, currency, enabled,
				 default_token, default_network, credential_encrypted, credential_key_version)
				 VALUES ('ch-alipay', '支付宝', 'epay', 'CNY', 1, '', '', ?, 1)`,
			)
			.bind(await epayCredential("alipay")),
		db
			.prepare(
				`INSERT INTO products (id, name, product_type, status, created_at, updated_at)
				 VALUES (?, 'ChatGPT Plus', 'stock', 'active', 1, 1),
				        (?, '分站搭建', 'automation', 'active', 1, 1),
				        (?, 'ChatGPT 会员升级（补差价）', 'automation', 'active', 1, 1),
				        (?, '补差价', 'stock', 'active', 1, 1),
				        ('product-test', '测试商品', 'stock', 'active', 1, 1)`,
			)
			.bind(
				productId,
				agentAccessProducts.subsite.productId,
				"10000000-0000-4000-8000-000000000001",
				priceDifferenceProductId,
			),
		db
			.prepare(
				`INSERT INTO product_sellable_items (id, product_id, name, price_minor, created_at, updated_at)
				 VALUES (?, ?, 'ChatGPT Plus 1个月', '100', 1, 1),
				        (?, ?, 'ChatGPT Plus 3个月', '300', 1, 1)`,
			)
			.bind(itemId, productId, otherItemId, productId),
	]);
}

type SeedOrder = {
	id: string;
	email: string;
	attempt?: "usdt" | "alipay" | null;
	pricingChannelId?: string;
	createdAt?: number;
	status?: string;
	paidAt?: number;
	paidMinor?: string;
	userId?: string;
	locale?: "zh-CN" | "en-US";
	itemId?: string;
	priceMinor?: string;
	product?: "agent" | "upgrade" | "difference" | "test";
};

async function seedOrder(db: D1Database, input: SeedOrder) {
	const created = input.createdAt ?? createdAt;
	const status = input.status ?? "expired";
	const price = input.priceMinor ?? "100";
	const product =
		input.product === "agent"
			? [
					agentAccessProducts.subsite.productId,
					agentAccessProducts.subsite.itemId,
					"分站搭建",
					"分站搭建（3个月）",
				]
			: input.product === "upgrade"
				? [
						"10000000-0000-4000-8000-000000000001",
						"10000000-0000-4000-8000-000000000002",
						"ChatGPT 会员升级（补差价）",
						"Plus → Pro",
					]
				: input.product === "difference"
					? [priceDifferenceProductId, "diff-item", "补差价", "1元"]
					: input.product === "test"
						? [
								"product-test",
								"test-item",
								"测试商品",
								"测试一｜自动发货 1个月",
							]
						: [
								productId,
								input.itemId ?? itemId,
								"ChatGPT Plus",
								input.itemId === otherItemId
									? "ChatGPT Plus 3个月"
									: "ChatGPT Plus 1个月",
							];
	const statements = [
		db
			.prepare(
				`INSERT INTO shop_orders
				 (id, order_number, user_id, contact_email, normalized_contact_email, locale,
				  status, currency, currency_decimals, subtotal_minor, discount_minor,
				  total_minor, paid_minor, version, expires_at, paid_at, pricing_channel_id,
				  created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'CNY', 2, ?, '0', ?, ?, 2, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.id,
				`ORDER-${input.id.toUpperCase()}`,
				input.userId ?? null,
				input.email,
				input.email.toLowerCase(),
				input.locale ?? "zh-CN",
				status,
				price,
				price,
				input.paidMinor ?? (input.paidAt ? price : "0"),
				created + 30 * minute,
				input.paidAt ?? null,
				input.pricingChannelId ?? null,
				created,
				created,
			),
		db
			.prepare(
				`INSERT INTO shop_order_items
				 (id, order_id, product_id, sellable_item_id, delivery_component_id,
				  product_name, delivery_component_type, delivery_component_version,
				  sellable_item_name, quantity, unit_price_minor, discount_minor,
				  subtotal_minor, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'stock', 1, ?, 1, ?, '0', ?, 1, 1)`,
			)
			.bind(
				`${input.id}-item`,
				input.id,
				product[0],
				product[1],
				product[1],
				product[2],
				product[3],
				price,
				price,
			),
	];
	if (input.attempt)
		statements.push(
			db
				.prepare(
					`INSERT INTO payment_attempts
					 (id, order_id, channel_id, idempotency_key, status, amount_minor, currency, currency_decimals)
					 VALUES (?, ?, ?, ?, 'expired', ?, 'CNY', 2)`,
				)
				.bind(
					`${input.id}-attempt`,
					input.id,
					input.attempt === "usdt" ? "ch-usdt" : "ch-alipay",
					`${input.id}-attempt`,
					price,
				),
		);
	await db.batch(statements);
}

async function epayCredential(paymentMethod: "alipay" | "wxpay") {
	return encryptSecret(
		JSON.stringify({
			baseUrl: "https://pay.mail-buyer.cn",
			pid: "1001",
			secretKey: "epay-secret-key",
			paymentMethod,
		}),
		secret,
		"payment-credential",
	);
}
