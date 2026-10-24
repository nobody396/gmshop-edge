import { loadSettings } from "#/features/ops-automation/server/shared";
import {
	canonicalTimezone,
	claudeEnvSettingKeys,
	claudeEnvSkuIds,
	claudeEnvSkus,
	dayMs,
	desiredStatuses,
	displayCity,
	evaluateQuality,
	generateRelayPass,
	generateRelayUser,
	generateSubscriptionId,
	isIpv4,
	lowBalanceUsd,
	maskEmail,
	pickIproyalCity,
	pickRelayPort,
	portReuseMs,
	relayOfflineMs,
	relaySlotStatuses,
	staleClaimMs,
	timezoneForCity,
} from "../domain";
import { formatLabel, needsReplaceAlert, subscriptionLabel } from "./alerts";
import {
	enqueueClaudeEnvReadyEmail,
	type SendExpiryEmail,
} from "./customer-email";
import {
	createIproyalClient,
	type IproyalClient,
	IproyalError,
} from "./iproyal";
import { sendExpiryReminders } from "./reminders";
import {
	alertThrottled,
	type Crypt,
	type Deliver,
	defaultDeliver,
	eventStatement,
	loadCrypt,
	lookupScamScore,
	lookupTimezone,
	lookupTrustScore,
	secretPurpose,
} from "./shared";

const hourMs = 3_600_000;
const perTick = 5;

export const reorderHint =
	"先去 IPRoyal 后台核对有没有这一单，确认没有再点「允许重新下单」；有的话在后台填订单号。";
export const extendUnknownHint =
	"先核对 IPRoyal 这张订单的到期时间有没有延长，再决定：延长了点「已手动续期」，没延长点「重试续期」。";

export type ClaudeEnvCronInput = {
	db: D1Database;
	/** Worker secret IPROYAL_API_TOKEN; never stored in D1. */
	iproyalToken?: string;
	now?: number;
	fetcher?: typeof fetch;
	deliver?: Deliver;
	crypt?: Crypt;
	/** Tests inject a fake client; production builds one from the token. */
	iproyal?: IproyalClient;
	sendCustomerEmail?: (subscriptionId: string) => Promise<unknown>;
	/** Tests inject the expiry-reminder email sender. */
	sendExpiryEmail?: SendExpiryEmail;
};

type Context = {
	db: D1Database;
	now: number;
	fetcher: typeof fetch;
	deliver: Deliver;
	crypt: Crypt;
	iproyal: IproyalClient | null;
	sendCustomerEmail: (subscriptionId: string) => Promise<unknown>;
};

const beijing = (ms: number) =>
	new Date(ms + 8 * hourMs).toISOString().slice(0, 16).replace("T", " ");

const planLabel: Record<string, string> = {
	monthly: "月付",
	quarterly: "季付",
	eb_monthly: "早鸟月付",
	eb_quarterly: "早鸟季付",
};

const say = (context: Context, text: string) =>
	context.deliver(text).catch(() => undefined);

/** Every minute (behind `claude_env.automation_enabled`). Each step is isolated. */
export async function runClaudeEnv(input: ClaudeEnvCronInput) {
	const now = input.now ?? Date.now();
	const settings = await loadSettings(input.db, [
		claudeEnvSettingKeys.enabled,
		claudeEnvSettingKeys.ingestAfter,
	]);
	if (settings.get(claudeEnvSettingKeys.enabled) !== true)
		return { status: "disabled" as const };
	// Written only by the admin switch, at the moment it is turned on.
	const ingestAfter = settings.get(claudeEnvSettingKeys.ingestAfter);
	const fetcher = input.fetcher ?? fetch;
	const context: Context = {
		db: input.db,
		now,
		fetcher,
		deliver: input.deliver ?? defaultDeliver(input.db, fetcher),
		crypt: input.crypt ?? (await loadCrypt(input.db)),
		iproyal:
			input.iproyal ??
			(input.iproyalToken
				? createIproyalClient(input.iproyalToken, fetcher)
				: null),
		sendCustomerEmail:
			input.sendCustomerEmail ??
			((id) => enqueueClaudeEnvReadyEmail(input.db, id)),
	};
	const step = async <T>(work: () => Promise<T>) => {
		try {
			return await work();
		} catch (error) {
			return { failed: error instanceof Error ? error.message : "error" };
		}
	};
	return {
		status: "ok" as const,
		ingested: await step(async () =>
			typeof ingestAfter === "number" && Number.isSafeInteger(ingestAfter)
				? await ingestOrders(context, ingestAfter)
				: ("no_ingest_after" as const),
		),
		waiting: await step(() => promoteWaitingOrders(context)),
		refunds: await step(() => handleRefunds(context)),
		renewalRefunds: await step(() => handleRenewalRefunds(context)),
		provisioned: await step(() => provisionSubscriptions(context)),
		stalePosting: await step(() => alertStalePosting(context)),
		activated: await step(() => activateSubscriptions(context)),
		extended: await step(() => extendPeriods(context)),
		staleExtending: await step(() => alertStaleExtending(context)),
		synced: await step(() => syncExpiry(context)),
		expired: await step(() => expireSubscriptions(context)),
		reminders: await step(() =>
			sendExpiryReminders({
				db: context.db,
				now,
				deliver: context.deliver,
				sendEmail: input.sendExpiryEmail,
			}),
		),
		relays: await step(() => alertOfflineRelays(context)),
		pruned: await step(() =>
			context.db
				.prepare("DELETE FROM claude_env_reports WHERE received_at < ?")
				.bind(now - 7 * dayMs)
				.run()
				.then((r) => Number(r.meta.changes ?? 0)),
		),
	};
}

// ---------- 1. paid orders → subscriptions / renewals ----------

type PaidItem = {
	order_item_id: string;
	order_id: string;
	order_number: string;
	sellable_item_id: string;
	quantity: number;
	user_id: string | null;
	user_email: string | null;
	contact_email: string | null;
	via_api: number;
};

const paidItemColumns = `oi.id AS order_item_id, oi.order_id, o.order_number, oi.sellable_item_id, oi.quantity,
 o.user_id, u.email AS user_email, o.normalized_contact_email AS contact_email,
 EXISTS(SELECT 1 FROM supplier_api_orders sa WHERE sa.shop_order_id = o.id) AS via_api`;
const paidItemFrom = `FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
 LEFT JOIN users u ON u.id = o.user_id`;

export async function ingestOrders(context: Context, ingestAfter: number) {
	// Every handled item (including guests waiting to register) has a period
	// row, so it never occupies a batch slot again.
	const rows = await context.db
		.prepare(
			`SELECT ${paidItemColumns} ${paidItemFrom}
			 WHERE oi.sellable_item_id IN (${claudeEnvSkuIds.map(() => "?").join(",")})
			 AND o.status IN ('paid','fulfilling','completed') AND o.paid_at >= ?
			 AND NOT EXISTS (SELECT 1 FROM claude_env_periods p WHERE p.order_item_id = oi.id)
			 ORDER BY o.paid_at, oi.id LIMIT 20`,
		)
		.bind(...claudeEnvSkuIds, ingestAfter)
		.all<PaidItem>();
	const outcome = { created: 0, renewed: 0, skipped: 0, waiting: 0 };
	for (const row of rows.results)
		outcome[await processPaidItem(context, row)] += 1;
	return outcome;
}

async function resolveBuyer(db: D1Database, row: PaidItem) {
	if (row.user_id && row.user_email)
		return { userId: row.user_id, email: row.user_email };
	if (!row.contact_email) return null;
	const user = await db
		.prepare(
			"SELECT id, email FROM users WHERE lower(email) = lower(?) AND email_verified = 1 LIMIT 1",
		)
		.bind(row.contact_email)
		.first<{ id: string; email: string }>();
	return user ? { userId: user.id, email: user.email } : null;
}

const guestReminder = (orderNumber: string, count: number) =>
	`⚠️ Claude 专属环境游客订单 ${orderNumber}（第 ${count}/3 次提醒）：客户还没用下单邮箱注册/验证主站账号，面板只对登录用户开放。客户登录并验证邮箱后系统会自动开通；可以让客服提醒客户注册。`;

async function processPaidItem(
	context: Context,
	row: PaidItem,
): Promise<"created" | "renewed" | "skipped" | "waiting"> {
	const { db, now } = context;
	const sku = claudeEnvSkus[row.sellable_item_id];
	if (!sku) return "skipped";
	const quantity = Math.max(1, row.quantity);
	const days = sku.days * quantity;
	if (row.via_api) {
		const reason =
			"代理站（lsrai.shop）经供货 API 下的单（下单账号是代理，不是最终客户），系统不自动开通";
		await periodInsert(db, row, null, "skipped", sku, days, quantity, now, {
			note: reason,
		}).run();
		await say(
			context,
			`⚠️ Claude 专属环境订单需要人工处理\n订单 ${row.order_number}｜${planLabel[sku.plan]} ×${quantity}\n原因：${reason}`,
		);
		return "skipped";
	}
	const buyer = await resolveBuyer(db, row);
	if (!buyer) {
		// Guest checkout: claimed onto an account once the buyer verifies the
		// order email. Reminders on day 1, 3 and 7 only.
		await periodInsert(db, row, null, "waiting", sku, days, quantity, now, {
			remindCount: 1,
			nextRemindAt: now + 2 * dayMs,
		}).run();
		await say(context, guestReminder(row.order_number, 1));
		return "waiting";
	}
	const existing = await db
		.prepare(
			`SELECT id, status, ip, iproyal_order_id, iproyal_order_state FROM claude_env_subscriptions
			 WHERE user_id = ? AND status IN ('awaiting_ip','provisioning','needs_replace','active','suspended')
			 AND (expires_at IS NULL OR expires_at > ?)
			 ORDER BY created_at DESC LIMIT 1`,
		)
		// Past its expiry the IP is gone: a purchase then is a brand-new
		// subscription with a new IP, never a renewal of the dead one.
		.bind(buyer.userId, now)
		.first<{
			id: string;
			status: string;
			ip: string | null;
			iproyal_order_id: string | null;
			iproyal_order_state: string | null;
		}>();
	if (existing) {
		// IPRoyal's expire_date is authoritative: the paid days are added by
		// extending the IPRoyal order, then re-reading its expire_date.
		const noOrder = existing.ip !== null && !existing.iproyal_order_id;
		await db.batch([
			periodInsert(db, row, existing.id, "renewal", sku, days, quantity, now, {
				extendStatus: noOrder ? "failed" : "pending",
				note: noOrder ? "no_iproyal_order" : null,
			}),
			eventStatement(
				db,
				existing.id,
				"renewed",
				`+${days} 天（订单 ${row.order_number}）`,
				now,
			),
		]);
		const { text } = await subscriptionLabel(db, existing.id);
		const next = noOrder
			? "⚠️ 这个订阅没有 IPRoyal 订单号（手动换过 IP），系统没法自动续期。请到 IPRoyal 后台手动续期，然后在后台点「已手动续期」。"
			: existing.status === "needs_replace"
				? "⚠️ 这个订阅正在等换 IP，系统不会对旧 IPRoyal 订单续期。换好 IP 并在后台填新订单号后会自动续期。"
				: existing.iproyal_order_state !== "ordered"
					? "还没买到 IP，买好后会自动续期。"
					: "IPRoyal 续期会自动处理，到期时间以 IPRoyal 实际到期为准；失败会另外提醒。";
		await say(
			context,
			[
				"🔁 Claude 专属环境续费",
				text,
				`${planLabel[sku.plan]} ×${quantity}，+${days} 天，IP 不变`,
				next,
			].join("\n"),
		);
		return "renewed";
	}
	const id = generateSubscriptionId();
	await db.batch([
		db
			.prepare(
				`INSERT INTO claude_env_subscriptions
				 (id, user_id, email, order_id, order_item_id, plan, status, iproyal_plan_id, pending_days, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'awaiting_ip', ?, ?, ?, ?)`,
			)
			.bind(
				id,
				buyer.userId,
				buyer.email,
				row.order_id,
				row.order_item_id,
				sku.plan,
				sku.iproyalPlanId,
				days,
				now,
				now,
			),
		periodInsert(db, row, id, "initial", sku, days, quantity, now),
		eventStatement(db, id, "created", `订单 ${row.order_number}`, now),
	]);
	await say(
		context,
		[
			"🆕 Claude 专属环境新订单（已付款）",
			`订单 ${row.order_number}｜客户 ${maskEmail(buyer.email)}`,
			`${planLabel[sku.plan]} ×${quantity}（${days} 天）`,
			"系统开始自动买 IP、质检、开通，完成后再通知你。",
		].join("\n"),
	);
	return "created";
}

function periodInsert(
	db: D1Database,
	row: PaidItem,
	subscriptionId: string | null,
	kind: "initial" | "renewal" | "skipped" | "waiting",
	sku: { plan: string; iproyalPlanId: number },
	days: number,
	units: number,
	now: number,
	extra: {
		note?: string | null;
		extendStatus?: string;
		remindCount?: number;
		nextRemindAt?: number | null;
	} = {},
) {
	return db
		.prepare(
			`INSERT INTO claude_env_periods
			 (order_item_id, order_id, subscription_id, kind, plan, days, units, iproyal_plan_id, units_extended,
			  extend_status, note, remind_count, next_remind_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.order_item_id,
			row.order_id,
			subscriptionId,
			kind,
			sku.plan,
			days,
			units,
			sku.iproyalPlanId,
			extra.extendStatus ?? (kind === "renewal" ? "pending" : "none"),
			extra.note ?? null,
			extra.remindCount ?? 0,
			extra.nextRemindAt ?? null,
			now,
			now,
		);
}

/** Guests who registered since are ingested; others get the day-3/day-7 reminders. */
export async function promoteWaitingOrders(context: Context) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT ${paidItemColumns}, o.status AS order_status, p.remind_count, p.next_remind_at, p.created_at AS waiting_since
			 ${paidItemFrom} JOIN claude_env_periods p ON p.order_item_id = oi.id
			 WHERE p.kind = 'waiting' ORDER BY p.created_at LIMIT 50`,
		)
		.all<
			PaidItem & {
				order_status: string;
				remind_count: number;
				next_remind_at: number | null;
				waiting_since: number;
			}
		>();
	let promoted = 0;
	for (const row of rows.results) {
		if (!["paid", "fulfilling", "completed"].includes(row.order_status)) {
			await db
				.prepare(
					"UPDATE claude_env_periods SET kind = 'skipped', note = ?, next_remind_at = NULL, updated_at = ? WHERE order_item_id = ? AND kind = 'waiting'",
				)
				.bind(`order_${row.order_status}`, now, row.order_item_id)
				.run();
			continue;
		}
		if (await resolveBuyer(db, row)) {
			const removed = await db
				.prepare(
					"DELETE FROM claude_env_periods WHERE order_item_id = ? AND kind = 'waiting'",
				)
				.bind(row.order_item_id)
				.run();
			if (Number(removed.meta.changes ?? 0) !== 1) continue;
			await processPaidItem(context, row);
			promoted += 1;
			continue;
		}
		if (
			row.remind_count < 3 &&
			row.next_remind_at !== null &&
			row.next_remind_at <= now
		) {
			const count = row.remind_count + 1;
			const claimed = await db
				.prepare(
					"UPDATE claude_env_periods SET remind_count = ?, next_remind_at = ?, updated_at = ? WHERE order_item_id = ? AND remind_count = ?",
				)
				.bind(
					count,
					count < 3 ? row.waiting_since + 6 * dayMs : null,
					now,
					row.order_item_id,
					row.remind_count,
				)
				.run();
			if (Number(claimed.meta.changes ?? 0) === 1)
				await say(context, guestReminder(row.order_number, count));
		}
	}
	return promoted;
}

// ---------- 2. refunds ----------

export async function handleRefunds(context: Context) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT s.id, s.status, s.iproyal_order_state FROM claude_env_subscriptions s
			 JOIN shop_orders o ON o.id = s.order_id
			 WHERE o.status = 'refunded' AND s.refund_seen = 0 LIMIT 20`,
		)
		.all<{ id: string; status: string; iproyal_order_state: string | null }>();
	for (const row of rows.results) {
		const { text } = await subscriptionLabel(db, row.id);
		if (row.status === "awaiting_ip" && row.iproyal_order_state === null) {
			const [cancelled] = await db.batch([
				db
					.prepare(
						"UPDATE claude_env_subscriptions SET status = 'cancelled', relay_id = NULL, relay_port = NULL, refund_seen = 1, updated_at = ? WHERE id = ? AND status = 'awaiting_ip' AND iproyal_order_state IS NULL",
					)
					.bind(now, row.id),
				db
					.prepare(
						"INSERT INTO claude_env_events (id, subscription_id, kind, detail, created_at) SELECT ?, id, 'cancelled', '订单已退款', ? FROM claude_env_subscriptions WHERE id = ? AND status = 'cancelled'",
					)
					.bind(crypto.randomUUID(), now, row.id),
			]);
			if (Number(cancelled?.meta.changes ?? 0) === 1) {
				await say(
					context,
					`ℹ️ Claude 专属环境订单已退款，还没买 IP，已取消\n${text}`,
				);
				continue;
			}
			// Lost the race against a purchase that just started.
			await say(
				context,
				`⚠️ 退款单可能已买了 IP，请人工处理（到 IPRoyal 后台核对）\n${text}`,
			);
		}
		const suspend = !["expired", "cancelled", "suspended"].includes(row.status);
		await db.batch([
			db
				.prepare(
					`UPDATE claude_env_subscriptions SET refund_seen = 1,
					 status_before_suspend = CASE WHEN ? THEN status ELSE status_before_suspend END,
					 status = CASE WHEN ? THEN 'suspended' ELSE status END, updated_at = ? WHERE id = ?`,
				)
				.bind(suspend ? 1 : 0, suspend ? 1 : 0, now, row.id),
			eventStatement(db, row.id, "refunded", "首单已退款，已停用", now),
		]);
		await say(
			context,
			`⚠️ Claude 专属环境首单已退款${suspend ? "，已自动停用" : ""}\n${text}\nIPRoyal 订单不会自动续费；需要的话请手动处理。`,
		);
	}
	return rows.results.length;
}

/** A refunded renewal order: cancel the extension if IPRoyal was not extended yet, else alert. */
export async function handleRenewalRefunds(context: Context) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT p.order_item_id, p.subscription_id, p.extend_status, p.units_extended, p.days, o.order_number
			 FROM claude_env_periods p JOIN shop_orders o ON o.id = p.order_id
			 WHERE p.kind = 'renewal' AND o.status = 'refunded' AND p.refund_handled = 0 LIMIT 20`,
		)
		.all<{
			order_item_id: string;
			subscription_id: string;
			extend_status: string;
			units_extended: number;
			days: number;
			order_number: string;
		}>();
	for (const row of rows.results) {
		const cancel = await db
			.prepare(
				`UPDATE claude_env_periods SET extend_status = 'cancelled', refund_handled = 1, note = 'refunded', updated_at = ?
				 WHERE order_item_id = ? AND extend_status IN ('pending','failed') AND units_extended = 0`,
			)
			.bind(now, row.order_item_id)
			.run();
		const { text } = await subscriptionLabel(db, row.subscription_id);
		if (Number(cancel.meta.changes ?? 0) === 1) {
			await eventStatement(
				db,
				row.subscription_id,
				"renewal_refunded",
				`订单 ${row.order_number} 已退款，取消续期`,
				now,
			).run();
			await say(
				context,
				`ℹ️ Claude 专属环境续费单 ${row.order_number} 已退款：IPRoyal 还没续期，已取消这次续期（到期时间不变）。\n${text}`,
			);
			continue;
		}
		await db
			.prepare(
				"UPDATE claude_env_periods SET refund_handled = 1, updated_at = ? WHERE order_item_id = ?",
			)
			.bind(now, row.order_item_id)
			.run();
		await say(
			context,
			`⚠️ Claude 专属环境续费单 ${row.order_number} 已退款，但 IPRoyal ${row.extend_status === "extending" ? "可能已经" : "已经"}续期了 ${row.days} 天。系统没有改到期时间，请人工决定（缩短到期或其他处理）。\n${text}`,
		);
	}
	return rows.results.length;
}

// ---------- 3. relay slot + IPRoyal purchase + polling ----------

type AwaitingRow = {
	id: string;
	relay_id: string | null;
	iproyal_plan_id: number;
	iproyal_order_state: string | null;
	iproyal_order_id: string | null;
	iproyal_location: string | null;
	ip_invalid_alerted: number;
	order_item_id: string;
};

export async function assignRelay(
	db: D1Database,
	crypt: Crypt,
	subId: string,
	now: number,
) {
	const relays = await db
		.prepare(
			`SELECT r.id, r.max_customers,
			 (SELECT COUNT(*) FROM claude_env_subscriptions s WHERE s.relay_id = r.id
			  AND s.status IN (${relaySlotStatuses.map(() => "?").join(",")})) AS used
			 FROM claude_env_relays r WHERE r.status = 'active' ORDER BY used, r.id`,
		)
		.bind(...relaySlotStatuses)
		.all<{ id: string; max_customers: number; used: number }>();
	const relay = relays.results.find((r) => r.used < r.max_customers);
	if (!relay) return null;
	// Ports of customers expired for more than 30 days go back to the pool;
	// anything newer keeps its port so a stale client never reaches someone else.
	await db
		.prepare(
			"UPDATE claude_env_subscriptions SET relay_port = NULL WHERE relay_id = ? AND status = 'expired' AND relay_port IS NOT NULL AND COALESCE(expired_at, updated_at) < ?",
		)
		.bind(relay.id, now - portReuseMs)
		.run();
	const ports = await db
		.prepare(
			"SELECT relay_port FROM claude_env_subscriptions WHERE relay_id = ? AND relay_port IS NOT NULL",
		)
		.bind(relay.id)
		.all<{ relay_port: number }>();
	const port = pickRelayPort(ports.results.map((r) => r.relay_port));
	if (port === null) return null;
	const result = await db
		.prepare(
			`UPDATE claude_env_subscriptions SET relay_id = ?, relay_port = ?, relay_user = ?, relay_pass_encrypted = ?, updated_at = ?
			 WHERE id = ? AND relay_id IS NULL`,
		)
		.bind(
			relay.id,
			port,
			generateRelayUser(),
			await crypt.encrypt(generateRelayPass(), secretPurpose.relayPass),
			now,
			subId,
		)
		.run();
	return Number(result.meta.changes ?? 0) === 1 ? relay.id : null;
}

export async function provisionSubscriptions(context: Context) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT s.id, s.relay_id, s.iproyal_plan_id, s.iproyal_order_state, s.iproyal_order_id,
			 s.iproyal_location, s.ip_invalid_alerted, s.order_item_id
			 FROM claude_env_subscriptions s
			 WHERE s.status = 'awaiting_ip' AND s.attempt_after <= ?
			 AND (s.iproyal_order_state IS NULL OR s.iproyal_order_state = 'ordered')
			 ORDER BY s.created_at LIMIT ?`,
		)
		.bind(now, perTick)
		.all<AwaitingRow>();
	const outcome = { ordered: 0, delivered: 0, waiting: 0 };
	for (const row of rows.results) {
		if (!row.relay_id) {
			const relayId = await assignRelay(db, context.crypt, row.id, now).catch(
				() => null,
			);
			if (!relayId) {
				await backoff(db, row.id, now + 5 * 60_000, "no_relay");
				await alertThrottled(
					db,
					context.deliver,
					claudeEnvSettingKeys.alertNoRelay,
					"⚠️ Claude 专属环境：中转机满了/没有可用中转机，新客户在排队。请在后台「Claude 专属环境」加一台中转机或调大容量。",
					now,
					hourMs,
				);
				outcome.waiting += 1;
				continue;
			}
		}
		if (!context.iproyal) {
			await alertThrottled(
				db,
				context.deliver,
				claudeEnvSettingKeys.alertNoToken,
				"⚠️ Claude 专属环境：Worker 没有配置 IPROYAL_API_TOKEN，没法自动买 IP，客户在等。请用 wrangler secret put IPROYAL_API_TOKEN 设置。",
				now,
				6 * hourMs,
			);
			return { ...outcome, waiting: outcome.waiting + rows.results.length };
		}
		if (row.iproyal_order_state === null) {
			const placed = await placeOrder(context, row);
			if (placed) outcome.ordered += 1;
			else outcome.waiting += 1;
			continue;
		}
		if (await pollOrder(context, row)) outcome.delivered += 1;
		else outcome.waiting += 1;
	}
	return outcome;
}

async function backoff(
	db: D1Database,
	id: string,
	until: number,
	error: string,
) {
	await db
		.prepare(
			"UPDATE claude_env_subscriptions SET attempt_after = ?, last_error = ?, updated_at = ? WHERE id = ?",
		)
		.bind(until, error, Date.now(), id)
		.run();
}

async function placeOrder(context: Context, row: AwaitingRow) {
	const { db, now } = context;
	const iproyal = context.iproyal as IproyalClient;
	let balance: number;
	let city: { id: number; name: string } | null;
	let price: number | null;
	try {
		balance = await iproyal.balance();
		city = pickIproyalCity(await iproyal.products());
		price = city ? await iproyal.price(row.iproyal_plan_id, city.id) : null;
	} catch (error) {
		await backoff(db, row.id, now + 5 * 60_000, errorCode(error));
		return false;
	}
	if (!city) {
		await backoff(db, row.id, now + 10 * 60_000, "no_city_in_stock");
		await alertThrottled(
			db,
			context.deliver,
			`${claudeEnvSettingKeys.alertBalance}.stock`,
			"⚠️ Claude 专属环境：IPRoyal 美国 ISP 现在全部缺货，没有扣费，系统每 10 分钟重试。",
			now,
			hourMs,
		);
		return false;
	}
	if (price === null || balance < price) {
		await backoff(db, row.id, now + 10 * 60_000, "balance_short");
		await alertThrottled(
			db,
			context.deliver,
			claudeEnvSettingKeys.alertBalance,
			`⚠️ IPRoyal 余额不足：余额 $${balance.toFixed(2)}${price === null ? "（查不到价格）" : `，买 1 个 IP 需要 $${price.toFixed(2)}`}。充值后系统会自动继续，不用手动买。`,
			now,
			hourMs,
		);
		return false;
	}
	// Idempotency: claim the single POST /orders slot before calling IPRoyal.
	const claim = await db
		.prepare(
			"UPDATE claude_env_subscriptions SET iproyal_order_state = 'posting', iproyal_posting_at = ?, order_unknown_alerted = 0, iproyal_location = ?, updated_at = ? WHERE id = ? AND iproyal_order_state IS NULL AND status = 'awaiting_ip'",
		)
		.bind(now, city.name, now, row.id)
		.run();
	if (Number(claim.meta.changes ?? 0) !== 1) return false;
	let orderId: string;
	try {
		orderId = await iproyal.createOrder(row.iproyal_plan_id, city.id);
	} catch (error) {
		if (error instanceof IproyalError && error.definite) {
			// A 4xx means IPRoyal refused: nothing was bought, a later retry is safe.
			await db
				.prepare(
					"UPDATE claude_env_subscriptions SET iproyal_order_state = NULL, iproyal_posting_at = NULL, attempt_after = ?, last_error = ?, updated_at = ? WHERE id = ? AND iproyal_order_state = 'posting'",
				)
				.bind(now + 10 * 60_000, errorCode(error), now, row.id)
				.run();
			await alertThrottled(
				db,
				context.deliver,
				`${claudeEnvSettingKeys.alertBalance}.rejected`,
				`⚠️ IPRoyal 拒绝了下单（HTTP ${error.status}），没有扣费，系统 10 分钟后重试。\n${error.message.slice(0, 200)}`,
				now,
				hourMs,
			);
			return false;
		}
		await db.batch([
			db
				.prepare(
					"UPDATE claude_env_subscriptions SET iproyal_order_state = 'unknown', order_unknown_alerted = 1, last_error = ?, updated_at = ? WHERE id = ? AND iproyal_order_state = 'posting'",
				)
				.bind(errorCode(error), now, row.id),
			eventStatement(db, row.id, "order_unknown", errorCode(error), now),
		]);
		const { text } = await subscriptionLabel(db, row.id);
		await say(
			context,
			`⚠️ IPRoyal 下单结果不明（${errorCode(error)}），为防止重复扣钱，系统不会再下单。\n${text}\n${reorderHint}（5 分钟后按钮才可用）`,
		);
		return false;
	}
	const [written] = await db.batch([
		db
			.prepare(
				"UPDATE claude_env_subscriptions SET iproyal_order_state = 'ordered', iproyal_order_id = ?, attempt_after = ?, last_error = NULL, updated_at = ? WHERE id = ? AND iproyal_order_state = 'posting'",
			)
			.bind(orderId, now + 30_000, now, row.id),
		db
			.prepare(
				"UPDATE claude_env_periods SET units_extended = 1, extend_status = CASE WHEN units > 1 THEN 'pending' ELSE 'done' END, updated_at = ? WHERE order_item_id = ? AND kind = 'initial' AND EXISTS (SELECT 1 FROM claude_env_subscriptions s WHERE s.id = ? AND s.iproyal_order_id = ?)",
			)
			.bind(now, row.order_item_id, row.id, orderId),
		eventStatement(db, row.id, "ip_ordered", `${city.name} #${orderId}`, now),
	]);
	if (Number(written?.meta.changes ?? 0) !== 1) {
		const { text } = await subscriptionLabel(db, row.id);
		await say(
			context,
			`⚠️ IPRoyal 已下单成功（订单 ${orderId}），但订阅状态已被改动，没有写回。请人工核对并在后台填这个订单号。\n${text}`,
		);
		return false;
	}
	const remaining = balance - (price ?? 0);
	if (remaining < lowBalanceUsd)
		await alertThrottled(
			db,
			context.deliver,
			claudeEnvSettingKeys.alertBalanceLow,
			`⚠️ IPRoyal 余额偏低：约 $${remaining.toFixed(2)}（低于 $${lowBalanceUsd}），请尽快充值。`,
			now,
			12 * hourMs,
		);
	return true;
}

/** A `posting` claim that never finished (worker died mid-call) is reported once. */
export async function alertStalePosting(context: Context) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT id FROM claude_env_subscriptions
			 WHERE iproyal_order_state IN ('posting','unknown') AND order_unknown_alerted = 0
			 AND COALESCE(iproyal_posting_at, 0) < ? LIMIT 20`,
		)
		.bind(now - staleClaimMs)
		.all<{ id: string }>();
	for (const row of rows.results) {
		const claimed = await db
			.prepare(
				"UPDATE claude_env_subscriptions SET iproyal_order_state = 'unknown', order_unknown_alerted = 1, updated_at = ? WHERE id = ? AND order_unknown_alerted = 0",
			)
			.bind(now, row.id)
			.run();
		if (Number(claimed.meta.changes ?? 0) !== 1) continue;
		const { text } = await subscriptionLabel(db, row.id);
		await say(
			context,
			`⚠️ IPRoyal 下单结果不明（超过 5 分钟没有结果），系统不会再下单。\n${text}\n${reorderHint}`,
		);
	}
	return rows.results.length;
}

async function pollOrder(context: Context, row: AwaitingRow) {
	const { db, now } = context;
	const iproyal = context.iproyal as IproyalClient;
	let order: Awaited<ReturnType<IproyalClient["getOrder"]>>;
	try {
		order = await iproyal.getOrder(row.iproyal_order_id as string);
	} catch (error) {
		await backoff(db, row.id, now + 60_000, errorCode(error));
		return false;
	}
	const proxy = order.proxy;
	if (!proxy) {
		await backoff(db, row.id, now + 60_000, "ip_not_assigned_yet");
		return false;
	}
	if (!isIpv4(proxy.ip)) {
		await backoff(db, row.id, now + 30 * 60_000, "ip_not_ipv4");
		if (!row.ip_invalid_alerted) {
			await db
				.prepare(
					"UPDATE claude_env_subscriptions SET ip_invalid_alerted = 1 WHERE id = ?",
				)
				.bind(row.id)
				.run();
			const { text } = await subscriptionLabel(db, row.id);
			await say(
				context,
				`⚠️ IPRoyal 返回的 IP 不是 IPv4（${String(proxy.ip).slice(0, 64)}），没有分配给客户。请到 IPRoyal 后台核对。\n${text}`,
			);
		}
		return false;
	}
	const cityName = row.iproyal_location ?? proxy.location;
	const tz = canonicalTimezone(
		(await lookupTimezone(proxy.ip, context.fetcher)) ??
			timezoneForCity(cityName),
	);
	// The customer's paid period follows IPRoyal's real expire_date (it starts
	// at purchase; quality checks take minutes, at most about a day).
	await db.batch([
		db
			.prepare(
				`UPDATE claude_env_subscriptions SET status = 'provisioning', ip = ?, ip_port = ?, ip_city = ?, ip_tz = ?,
				 ip_user_encrypted = ?, ip_pass_encrypted = ?, relay_check_ok = 0, relay_check_fail_streak = 0, apply_fail_streak = 0,
				 expires_at = COALESCE(?, expires_at), iproyal_expires_at = COALESCE(?, iproyal_expires_at),
				 expire_sync_needed = ?, expire_checked_at = ?,
				 attempt_after = 0, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_ip'`,
			)
			.bind(
				proxy.ip,
				proxy.port,
				cityName,
				tz,
				await context.crypt.encrypt(proxy.username, secretPurpose.upstreamUser),
				await context.crypt.encrypt(proxy.password, secretPurpose.upstreamPass),
				order.expiresAt,
				order.expiresAt,
				order.expiresAt === null ? 1 : 0,
				now,
				now,
				row.id,
			),
		eventStatement(db, row.id, "ip_delivered", proxy.ip, now),
	]);
	return true;
}

function errorCode(error: unknown) {
	if (error instanceof IproyalError)
		return `${error.code}${error.status ? `_${error.status}` : ""}`;
	return error instanceof Error ? error.name : "error";
}

// ---------- 4. control-center quality check + activation ----------

export async function activateSubscriptions(context: Context) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT id, ip, pending_days, expires_at, relay_scam_score FROM claude_env_subscriptions
			 WHERE status = 'provisioning' AND relay_check_ok = 1 AND ip IS NOT NULL AND attempt_after <= ?
			 ORDER BY updated_at LIMIT ?`,
		)
		.bind(now, perTick)
		.all<{
			id: string;
			ip: string;
			pending_days: number;
			expires_at: number | null;
			relay_scam_score: number | null;
		}>();
	let activated = 0;
	let rejected = 0;
	for (const row of rows.results) {
		// scamalytics usually blocks Cloudflare Workers: prefer the score the
		// relay measured, fall back to our own fetch, else warn only.
		const [trustScore, scamScore] = await Promise.all([
			lookupTrustScore(row.ip, context.fetcher),
			row.relay_scam_score ?? lookupScamScore(row.ip, context.fetcher),
		]);
		const quality = evaluateQuality({ trustScore, scamScore });
		const note = [...quality.fails, ...quality.warns].join("；") || null;
		if (!quality.pass) {
			const reason = quality.fails.join("；");
			await db.batch([
				db
					.prepare(
						`UPDATE claude_env_subscriptions SET status = 'needs_replace', needs_replace_reason = ?, qc_trust_score = ?,
						 qc_scam_score = ?, qc_note = ?, qc_at = ?, relay_check_ok = 0, updated_at = ? WHERE id = ? AND status = 'provisioning'`,
					)
					.bind(reason, trustScore, scamScore, note, now, now, row.id),
				eventStatement(db, row.id, "needs_replace", reason, now),
			]);
			const { text } = await subscriptionLabel(db, row.id);
			await say(context, needsReplaceAlert(text, reason));
			rejected += 1;
			continue;
		}
		// expires_at normally already holds IPRoyal's expire_date; the
		// pending-days fallback only applies when it could not be read.
		const expiresAt =
			row.expires_at ?? now + Math.max(0, row.pending_days) * dayMs;
		const result = await db.batch([
			db
				.prepare(
					`UPDATE claude_env_subscriptions SET status = 'active', activated_at = ?, expires_at = ?, pending_days = 0,
					 expire_sync_needed = CASE WHEN ? THEN 1 ELSE expire_sync_needed END,
					 traffic_period_start = ?, traffic_period_bytes = 0, qc_trust_score = ?, qc_scam_score = ?, qc_note = ?, qc_at = ?,
					 exit_fail_streak = 0, patrol_alerted = 0, needs_replace_reason = NULL, updated_at = ?
					 WHERE id = ? AND status = 'provisioning' AND relay_check_ok = 1`,
				)
				.bind(
					now,
					expiresAt,
					row.expires_at === null ? 1 : 0,
					now,
					trustScore,
					scamScore,
					note,
					now,
					now,
					row.id,
				),
			eventStatement(db, row.id, "activated", note, now),
		]);
		if (Number(result[0]?.meta.changes ?? 0) !== 1) continue;
		activated += 1;
		const label = await subscriptionLabel(db, row.id);
		await say(
			context,
			[
				"✅ Claude 专属环境已开通（质检通过，已通知客户）",
				label.row
					? formatLabel({ ...label.row, iproyal_order_id: null })
					: label.text,
				`城市 ${displayCity(label.row?.ip_city) ?? "?"}｜到期 ${beijing(expiresAt)}（北京时间，跟 IPRoyal 到期一致）`,
				`信任分 ${trustScore ?? "查不到"}｜scamalytics ${scamScore ?? "查不到"}`,
			].join("\n"),
		);
		await context.sendCustomerEmail(row.id).catch(() => undefined);
	}
	return { activated, rejected };
}

// ---------- 5. IPRoyal extensions (renewals, multi-unit first orders) ----------

/** Re-reads IPRoyal's expire_date and makes it the subscription's expiry. */
async function refreshExpiry(
	context: Context,
	subscriptionId: string,
	orderId: string,
) {
	const { db, now } = context;
	let expiresAt: number | null = null;
	try {
		expiresAt = (await (context.iproyal as IproyalClient).getOrder(orderId))
			.expiresAt;
	} catch {
		expiresAt = null;
	}
	if (expiresAt === null) {
		await db
			.prepare(
				"UPDATE claude_env_subscriptions SET expire_sync_needed = 1, expire_checked_at = ? WHERE id = ?",
			)
			.bind(now, subscriptionId)
			.run();
		return null;
	}
	await db
		.prepare(
			`UPDATE claude_env_subscriptions SET expires_at = ?, iproyal_expires_at = ?, expire_sync_needed = 0, expire_checked_at = ?,
			 updated_at = ? WHERE id = ? AND iproyal_order_id = ? AND status <> 'expired'`,
		)
		.bind(expiresAt, expiresAt, now, now, subscriptionId, orderId)
		.run();
	return expiresAt;
}

export async function extendPeriods(context: Context) {
	const { db, now } = context;
	if (!context.iproyal) return { extended: 0 };
	const rows = await db
		.prepare(
			`SELECT p.order_item_id, p.subscription_id, p.units, p.units_extended, p.iproyal_plan_id, p.days,
			 s.iproyal_order_id FROM claude_env_periods p JOIN claude_env_subscriptions s ON s.id = p.subscription_id
			 WHERE p.extend_status = 'pending' AND s.iproyal_order_state = 'ordered' AND s.iproyal_order_id IS NOT NULL
			 AND s.ip IS NOT NULL AND s.status NOT IN ('expired','cancelled','needs_replace')
			 ORDER BY p.created_at LIMIT ?`,
		)
		.bind(perTick)
		.all<{
			order_item_id: string;
			subscription_id: string;
			units: number;
			units_extended: number;
			iproyal_plan_id: number;
			days: number;
			iproyal_order_id: string;
		}>();
	let extended = 0;
	for (const row of rows.results) {
		const claim = await db
			.prepare(
				"UPDATE claude_env_periods SET extend_status = 'extending', extending_at = ?, stale_alerted = 0, updated_at = ? WHERE order_item_id = ? AND extend_status = 'pending'",
			)
			.bind(now, now, row.order_item_id)
			.run();
		if (Number(claim.meta.changes ?? 0) !== 1) continue;
		try {
			await context.iproyal.extendOrder(
				row.iproyal_order_id,
				row.iproyal_plan_id,
			);
		} catch (error) {
			const definite = error instanceof IproyalError && error.definite;
			const { text } = await subscriptionLabel(db, row.subscription_id);
			if (definite) {
				// 4xx: nothing was extended; retrying later is safe.
				await db.batch([
					db
						.prepare(
							"UPDATE claude_env_periods SET extend_status = 'failed', note = ?, updated_at = ? WHERE order_item_id = ?",
						)
						.bind(errorCode(error), now, row.order_item_id),
					eventStatement(
						db,
						row.subscription_id,
						"extend_failed",
						errorCode(error),
						now,
					),
				]);
				await say(
					context,
					[
						`⚠️ IPRoyal 续期被拒（${errorCode(error)}），没有扣费`,
						text,
						`如果是余额不足，充值后在后台「Claude 专属环境」点「重试续期」；或到 IPRoyal 后台给订单 ${row.iproyal_order_id} 手动续期${row.iproyal_plan_id === 25 ? " 90" : " 30"} 天（续费不换 IP）后点「已手动续期」。`,
					].join("\n"),
				);
				continue;
			}
			// Unknown outcome: stay in `extending`; retry only after a manual check.
			await db.batch([
				db
					.prepare(
						"UPDATE claude_env_periods SET stale_alerted = 1, note = ?, updated_at = ? WHERE order_item_id = ?",
					)
					.bind(errorCode(error), now, row.order_item_id),
				eventStatement(
					db,
					row.subscription_id,
					"extend_unknown",
					errorCode(error),
					now,
				),
			]);
			await say(
				context,
				[
					`⚠️ IPRoyal 续期结果不明（${errorCode(error)}），系统不会自动重试`,
					text,
					`${extendUnknownHint}（订单 ${row.iproyal_order_id}；5 分钟后「重试续期」按钮才可用）`,
				].join("\n"),
			);
			continue;
		}
		const done = row.units_extended + 1 >= row.units;
		await db.batch([
			db
				.prepare(
					"UPDATE claude_env_periods SET units_extended = units_extended + 1, extend_status = ?, extending_at = NULL, note = NULL, updated_at = ? WHERE order_item_id = ?",
				)
				.bind(done ? "done" : "pending", now, row.order_item_id),
			eventStatement(
				db,
				row.subscription_id,
				"iproyal_extended",
				row.iproyal_order_id,
				now,
			),
		]);
		extended += 1;
		const expiresAt = await refreshExpiry(
			context,
			row.subscription_id,
			row.iproyal_order_id,
		);
		if (done)
			await say(
				context,
				`✅ IPRoyal 已续期：订单 ${row.iproyal_order_id}，新到期 ${expiresAt ? `${beijing(expiresAt)}（北京时间）` : "稍后同步"}，IP 不变。`,
			);
	}
	return { extended };
}

/** An `extending` claim older than 5 minutes (worker died mid-call) is reported once. */
export async function alertStaleExtending(context: Context) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT p.order_item_id, p.subscription_id, s.iproyal_order_id FROM claude_env_periods p
			 LEFT JOIN claude_env_subscriptions s ON s.id = p.subscription_id
			 WHERE p.extend_status = 'extending' AND p.stale_alerted = 0 AND COALESCE(p.extending_at, 0) < ? LIMIT 20`,
		)
		.bind(now - staleClaimMs)
		.all<{
			order_item_id: string;
			subscription_id: string;
			iproyal_order_id: string | null;
		}>();
	for (const row of rows.results) {
		const claimed = await db
			.prepare(
				"UPDATE claude_env_periods SET stale_alerted = 1, updated_at = ? WHERE order_item_id = ? AND stale_alerted = 0",
			)
			.bind(now, row.order_item_id)
			.run();
		if (Number(claimed.meta.changes ?? 0) !== 1) continue;
		const { text } = await subscriptionLabel(db, row.subscription_id);
		await say(
			context,
			`⚠️ IPRoyal 续期结果不明（超过 5 分钟没有结果，订单 ${row.iproyal_order_id ?? "?"}）\n${text}\n${extendUnknownHint}`,
		);
	}
	return rows.results.length;
}

/** Retries expire_date reads that failed, and refreshes subscriptions about to expire. */
export async function syncExpiry(context: Context) {
	const { db, now } = context;
	if (!context.iproyal) return 0;
	const rows = await db
		.prepare(
			`SELECT id, iproyal_order_id FROM claude_env_subscriptions
			 WHERE iproyal_order_state = 'ordered' AND iproyal_order_id IS NOT NULL AND ip IS NOT NULL
			 AND status IN ('provisioning','active','suspended','needs_replace')
			 AND (expire_sync_needed = 1 OR (expires_at IS NOT NULL AND expires_at <= ?))
			 AND COALESCE(expire_checked_at, 0) < ?
			 ORDER BY expires_at LIMIT ?`,
		)
		.bind(now + hourMs, now - 30 * 60_000, perTick)
		.all<{ id: string; iproyal_order_id: string }>();
	for (const row of rows.results)
		await refreshExpiry(context, row.id, row.iproyal_order_id);
	return rows.results.length;
}

// ---------- 6. expiry (no grace period) ----------

/**
 * expires_at is IPRoyal's real expire_date: once it has passed the IP is gone,
 * so the subscription expires at once and leaves the relay's desired list on
 * its next sync. Nothing can bring it back; a new purchase gets a new IP.
 */
export async function expireSubscriptions(context: Context) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT id, email, ip FROM claude_env_subscriptions
			 WHERE status IN ('active','suspended') AND expires_at IS NOT NULL AND expires_at <= ?
			 ORDER BY expires_at LIMIT 50`,
		)
		.bind(now)
		.all<{ id: string; email: string; ip: string | null }>();
	let expired = 0;
	for (const row of rows.results) {
		const result = await db
			.prepare(
				`UPDATE claude_env_subscriptions SET status = 'expired', status_before_suspend = NULL, expired_at = ?, updated_at = ?
				 WHERE id = ? AND status IN ('active','suspended') AND expires_at IS NOT NULL AND expires_at <= ?`,
			)
			.bind(now, now, row.id, now)
			.run();
		if (Number(result.meta.changes ?? 0) !== 1) continue;
		expired += 1;
		// A paid renewal that IPRoyal never extended can no longer apply.
		const unapplied = await db
			.prepare(
				`SELECT p.extend_status, o.order_number FROM claude_env_periods p
				 LEFT JOIN shop_orders o ON o.id = p.order_id
				 WHERE p.subscription_id = ? AND p.kind = 'renewal' AND p.extend_status IN ('pending','failed','extending')`,
			)
			.bind(row.id)
			.all<{ extend_status: string; order_number: string | null }>();
		await db.batch([
			db
				.prepare(
					`UPDATE claude_env_periods SET extend_status = 'cancelled', note = 'expired_before_extend', updated_at = ?
					 WHERE subscription_id = ? AND kind = 'renewal' AND extend_status IN ('pending','failed')`,
				)
				.bind(now, row.id),
			eventStatement(db, row.id, "expired", null, now),
		]);
		await say(
			context,
			[
				`⛔ 已到期停用：${maskEmail(row.email)} ${row.ip ?? "（无 IP）"}`,
				"专属 IP 已随订单到期释放，不能恢复；客户再买会分配新 IP、需要重新运行配置命令。",
				...unapplied.results.map((p) =>
					p.extend_status === "extending"
						? `⚠️ 续费单 ${p.order_number ?? "?"} 的续期结果不明，请到 IPRoyal 后台核对并人工处理（可能需要退款）。`
						: `⚠️ 续费单 ${p.order_number ?? "?"} 已付款但没续上，已取消，请人工退款。`,
				),
			].join("\n"),
		);
	}
	return { expired };
}

// ---------- 7. relay heartbeat ----------

export async function alertOfflineRelays(context: Context) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT r.id, r.last_report_at FROM claude_env_relays r
			 WHERE r.status = 'active' AND r.offline_alerted_at IS NULL
			 AND COALESCE(r.last_report_at, r.created_at) < ?
			 AND EXISTS (SELECT 1 FROM claude_env_subscriptions s WHERE s.relay_id = r.id
			  AND s.status IN (${desiredStatuses.map(() => "?").join(",")}))`,
		)
		.bind(now - relayOfflineMs, ...desiredStatuses)
		.all<{ id: string; last_report_at: number | null }>();
	for (const row of rows.results) {
		await db
			.prepare(
				"UPDATE claude_env_relays SET offline_alerted_at = ? WHERE id = ? AND offline_alerted_at IS NULL",
			)
			.bind(now, row.id)
			.run();
		await say(
			context,
			`⚠️ 中转机 ${row.id} 已经 5 分钟以上没有上报（最近一次：${row.last_report_at ? `${beijing(row.last_report_at)} 北京时间` : "从未"}）。客户可能断线，请检查中转机和 ce-relay 服务。`,
		);
	}
	return rows.results.length;
}
