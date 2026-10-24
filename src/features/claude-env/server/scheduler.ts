import {
	loadSettings,
	settingStatement,
} from "#/features/ops-automation/server/shared";
import {
	claudeEnvSettingKeys,
	claudeEnvSkuIds,
	claudeEnvSkus,
	dayMs,
	desiredStatuses,
	displayCity,
	evaluateQuality,
	extendExpiry,
	generateRelayPass,
	generateRelayUser,
	generateSubscriptionId,
	graceMs,
	lowBalanceUsd,
	maskEmail,
	pickIproyalCity,
	pickRelayPort,
	relayOfflineMs,
	relaySlotStatuses,
	timezoneForCity,
} from "../domain";
import { formatLabel, needsReplaceAlert, subscriptionLabel } from "./alerts";
import { enqueueClaudeEnvReadyEmail } from "./customer-email";
import {
	createIproyalClient,
	type IproyalClient,
	IproyalError,
} from "./iproyal";
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

/** Every minute (behind `claude_env.automation_enabled`). Each step is isolated. */
export async function runClaudeEnv(input: ClaudeEnvCronInput) {
	const now = input.now ?? Date.now();
	const settings = await loadSettings(input.db, [
		claudeEnvSettingKeys.enabled,
		claudeEnvSettingKeys.ingestAfter,
	]);
	if (settings.get(claudeEnvSettingKeys.enabled) !== true)
		return { status: "disabled" as const };
	let ingestAfter = settings.get(claudeEnvSettingKeys.ingestAfter);
	if (typeof ingestAfter !== "number" || !Number.isSafeInteger(ingestAfter)) {
		// First tick after the owner turns the flag on: only orders paid from now on.
		ingestAfter = now;
		await settingStatement(
			input.db,
			claudeEnvSettingKeys.ingestAfter,
			now,
			now,
		).run();
	}
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
		ingested: await step(() => ingestOrders(context, ingestAfter as number)),
		refunds: await step(() => handleRefunds(context)),
		provisioned: await step(() => provisionSubscriptions(context)),
		activated: await step(() => activateSubscriptions(context)),
		extended: await step(() => extendPeriods(context)),
		expired: await step(() => expireSubscriptions(context)),
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

export async function ingestOrders(context: Context, ingestAfter: number) {
	const { db, now } = context;
	const rows = await db
		.prepare(
			`SELECT oi.id AS order_item_id, oi.order_id, o.order_number, oi.sellable_item_id, oi.quantity,
			 o.user_id, u.email AS user_email, o.normalized_contact_email AS contact_email,
			 EXISTS(SELECT 1 FROM supplier_api_orders sa WHERE sa.shop_order_id = o.id) AS via_api
			 FROM shop_order_items oi JOIN shop_orders o ON o.id = oi.order_id
			 LEFT JOIN users u ON u.id = o.user_id
			 WHERE oi.sellable_item_id IN (${claudeEnvSkuIds.map(() => "?").join(",")})
			 AND o.status IN ('paid','fulfilling','completed') AND o.paid_at >= ?
			 AND NOT EXISTS (SELECT 1 FROM claude_env_periods p WHERE p.order_item_id = oi.id)
			 ORDER BY o.paid_at, oi.id LIMIT 20`,
		)
		.bind(...claudeEnvSkuIds, ingestAfter)
		.all<PaidItem>();
	let created = 0;
	let renewed = 0;
	let skipped = 0;
	for (const row of rows.results) {
		const sku = claudeEnvSkus[row.sellable_item_id];
		if (!sku) continue;
		const quantity = Math.max(1, row.quantity);
		const days = sku.days * quantity;
		let userId = row.user_id;
		let email = row.user_email;
		if (!userId && row.contact_email) {
			const user = await db
				.prepare(
					"SELECT id, email FROM users WHERE lower(email) = lower(?) AND email_verified = 1 LIMIT 1",
				)
				.bind(row.contact_email)
				.first<{ id: string; email: string }>();
			if (user) {
				userId = user.id;
				email = user.email;
			}
		}
		if (!row.via_api && (!userId || !email)) {
			// Guest checkout: the order is claimed onto an account once the buyer
			// signs in with a verified email, so wait instead of skipping.
			await alertThrottled(
				db,
				context.deliver,
				`claude_env.alert.guest.${row.order_item_id}`,
				`⚠️ Claude 专属环境游客订单 ${row.order_number}：客户还没用下单邮箱注册/验证主站账号，面板只对登录用户开放。客户登录并验证邮箱后系统会自动开通；也可以让客服提醒客户注册。`,
				now,
				24 * hourMs,
			);
			skipped += 1;
			continue;
		}
		const skip = row.via_api
			? "代理站（lsrai.shop）经供货 API 下的单（下单账号是代理，不是最终客户），系统不自动开通"
			: null;
		if (skip) {
			await db.batch([
				periodInsert(db, row, null, "skipped", sku, days, quantity, now, skip),
			]);
			await context
				.deliver(
					`⚠️ Claude 专属环境订单需要人工处理\n订单 ${row.order_number}｜${planLabel[sku.plan]} ×${quantity}\n原因：${skip}`,
				)
				.catch(() => undefined);
			skipped += 1;
			continue;
		}
		const existing = await db
			.prepare(
				`SELECT id, status, activated_at, expires_at FROM claude_env_subscriptions
				 WHERE user_id = ? AND status IN ('awaiting_ip','provisioning','needs_replace','active','grace','suspended')
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.bind(userId)
			.first<{
				id: string;
				status: string;
				activated_at: number | null;
				expires_at: number | null;
			}>();
		if (existing) {
			const applyStatements: D1PreparedStatement[] = [];
			let newExpiry: number | null = null;
			if (existing.activated_at !== null) {
				newExpiry = extendExpiry(existing.expires_at, now, days);
				applyStatements.push(
					db
						.prepare(
							`UPDATE claude_env_subscriptions SET expires_at = ?,
							 status = CASE WHEN status = 'grace' THEN 'active' ELSE status END,
							 status_before_suspend = CASE WHEN status_before_suspend = 'grace' THEN 'active' ELSE status_before_suspend END,
							 updated_at = ? WHERE id = ?`,
						)
						.bind(newExpiry, now, existing.id),
				);
			} else
				applyStatements.push(
					db
						.prepare(
							"UPDATE claude_env_subscriptions SET pending_days = pending_days + ?, updated_at = ? WHERE id = ?",
						)
						.bind(days, now, existing.id),
				);
			await db.batch([
				periodInsert(db, row, existing.id, "renewal", sku, days, quantity, now),
				...applyStatements,
				eventStatement(
					db,
					existing.id,
					"renewed",
					`+${days} 天（订单 ${row.order_number}）`,
					now,
				),
			]);
			renewed += 1;
			const { text } = await subscriptionLabel(db, existing.id);
			await context
				.deliver(
					[
						"🔁 Claude 专属环境续费",
						text,
						`${planLabel[sku.plan]} ×${quantity}，+${days} 天，IP 不变`,
						newExpiry
							? `新到期：${beijing(newExpiry)}（北京时间）`
							: "还没开通，开通后从开通时起算",
						"IPRoyal 续期会自动处理，失败会另外提醒。",
					].join("\n"),
				)
				.catch(() => undefined);
			continue;
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
					userId,
					email,
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
		created += 1;
		await context
			.deliver(
				[
					"🆕 Claude 专属环境新订单（已付款）",
					`订单 ${row.order_number}｜客户 ${maskEmail(email as string)}`,
					`${planLabel[sku.plan]} ×${quantity}（${days} 天）`,
					"系统开始自动买 IP、质检、开通，完成后再通知你。",
				].join("\n"),
			)
			.catch(() => undefined);
	}
	return { created, renewed, skipped };
}

function periodInsert(
	db: D1Database,
	row: PaidItem,
	subscriptionId: string | null,
	kind: "initial" | "renewal" | "skipped",
	sku: { plan: string; iproyalPlanId: number },
	days: number,
	units: number,
	now: number,
	note: string | null = null,
) {
	return db
		.prepare(
			`INSERT INTO claude_env_periods
			 (order_item_id, order_id, subscription_id, kind, plan, days, units, iproyal_plan_id, units_extended, extend_status, note, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
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
			kind === "renewal" ? "pending" : "none",
			note,
			now,
			now,
		);
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
			await db.batch([
				db
					.prepare(
						"UPDATE claude_env_subscriptions SET status = 'cancelled', relay_id = NULL, relay_port = NULL, refund_seen = 1, updated_at = ? WHERE id = ?",
					)
					.bind(now, row.id),
				eventStatement(db, row.id, "cancelled", "订单已退款", now),
			]);
			await context
				.deliver(`ℹ️ Claude 专属环境订单已退款，还没买 IP，已取消\n${text}`)
				.catch(() => undefined);
			continue;
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
		await context
			.deliver(
				`⚠️ Claude 专属环境首单已退款${suspend ? "，已自动停用" : ""}\n${text}\nIPRoyal 订单不会自动续费；需要的话请手动处理。`,
			)
			.catch(() => undefined);
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
			 s.iproyal_location, s.order_item_id
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
			"UPDATE claude_env_subscriptions SET iproyal_order_state = 'posting', iproyal_location = ?, updated_at = ? WHERE id = ? AND iproyal_order_state IS NULL AND status = 'awaiting_ip'",
		)
		.bind(city.name, now, row.id)
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
					"UPDATE claude_env_subscriptions SET iproyal_order_state = NULL, attempt_after = ?, last_error = ?, updated_at = ? WHERE id = ? AND iproyal_order_state = 'posting'",
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
					"UPDATE claude_env_subscriptions SET iproyal_order_state = 'unknown', last_error = ?, updated_at = ? WHERE id = ?",
				)
				.bind(errorCode(error), now, row.id),
			eventStatement(db, row.id, "order_unknown", errorCode(error), now),
		]);
		const { text } = await subscriptionLabel(db, row.id);
		await context
			.deliver(
				`⚠️ IPRoyal 下单结果不明（${errorCode(error)}），为防止重复扣钱，系统不会再下单。\n${text}\n请到 IPRoyal 后台看有没有新订单：有就在后台「Claude 专属环境」填订单号；没有就点「允许重新下单」。`,
			)
			.catch(() => undefined);
		return false;
	}
	await db.batch([
		db
			.prepare(
				"UPDATE claude_env_subscriptions SET iproyal_order_state = 'ordered', iproyal_order_id = ?, attempt_after = ?, last_error = NULL, updated_at = ? WHERE id = ?",
			)
			.bind(orderId, now + 30_000, now, row.id),
		db
			.prepare(
				"UPDATE claude_env_periods SET units_extended = 1, extend_status = CASE WHEN units > 1 THEN 'pending' ELSE 'done' END, updated_at = ? WHERE order_item_id = ? AND kind = 'initial'",
			)
			.bind(now, row.order_item_id),
		eventStatement(db, row.id, "ip_ordered", `${city.name}`, now),
	]);
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

async function pollOrder(context: Context, row: AwaitingRow) {
	const { db, now } = context;
	const iproyal = context.iproyal as IproyalClient;
	let proxy: Awaited<ReturnType<IproyalClient["getOrder"]>>;
	try {
		proxy = await iproyal.getOrder(row.iproyal_order_id as string);
	} catch (error) {
		await backoff(db, row.id, now + 60_000, errorCode(error));
		return false;
	}
	if (!proxy) {
		await backoff(db, row.id, now + 60_000, "ip_not_assigned_yet");
		return false;
	}
	const cityName = row.iproyal_location ?? proxy.location;
	const tz =
		(await lookupTimezone(proxy.ip, context.fetcher)) ??
		timezoneForCity(cityName);
	await db.batch([
		db
			.prepare(
				`UPDATE claude_env_subscriptions SET status = 'provisioning', ip = ?, ip_port = ?, ip_city = ?, ip_tz = ?,
				 ip_user_encrypted = ?, ip_pass_encrypted = ?, relay_check_ok = 0, relay_check_fail_streak = 0,
				 attempt_after = 0, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_ip'`,
			)
			.bind(
				proxy.ip,
				proxy.port,
				cityName,
				tz,
				await context.crypt.encrypt(proxy.username, secretPurpose.upstreamUser),
				await context.crypt.encrypt(proxy.password, secretPurpose.upstreamPass),
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
			`SELECT id, ip, pending_days FROM claude_env_subscriptions
			 WHERE status = 'provisioning' AND relay_check_ok = 1 AND ip IS NOT NULL AND attempt_after <= ?
			 ORDER BY updated_at LIMIT ?`,
		)
		.bind(now, perTick)
		.all<{ id: string; ip: string; pending_days: number }>();
	let activated = 0;
	let rejected = 0;
	for (const row of rows.results) {
		const [trustScore, scamScore] = await Promise.all([
			lookupTrustScore(row.ip, context.fetcher),
			lookupScamScore(row.ip, context.fetcher),
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
			await context
				.deliver(needsReplaceAlert(text, reason))
				.catch(() => undefined);
			rejected += 1;
			continue;
		}
		const expiresAt = now + Math.max(0, row.pending_days) * dayMs;
		const result = await db.batch([
			db
				.prepare(
					`UPDATE claude_env_subscriptions SET status = 'active', activated_at = ?, expires_at = ?, pending_days = 0,
					 traffic_period_start = ?, traffic_period_bytes = 0, qc_trust_score = ?, qc_scam_score = ?, qc_note = ?, qc_at = ?,
					 exit_fail_streak = 0, patrol_alerted = 0, needs_replace_reason = NULL, updated_at = ?
					 WHERE id = ? AND status = 'provisioning' AND relay_check_ok = 1`,
				)
				.bind(
					now,
					expiresAt,
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
		await context
			.deliver(
				[
					"✅ Claude 专属环境已开通（质检通过，已通知客户）",
					label.row
						? formatLabel({ ...label.row, iproyal_order_id: null })
						: label.text,
					`城市 ${displayCity(label.row?.ip_city) ?? "?"}｜到期 ${beijing(expiresAt)}（北京时间）`,
					`信任分 ${trustScore ?? "查不到"}｜scamalytics ${scamScore ?? "查不到"}`,
				].join("\n"),
			)
			.catch(() => undefined);
		await context.sendCustomerEmail(row.id).catch(() => undefined);
	}
	return { activated, rejected };
}

// ---------- 5. IPRoyal extensions (renewals, multi-unit first orders) ----------

export async function extendPeriods(context: Context) {
	const { db, now } = context;
	if (!context.iproyal) return { extended: 0 };
	const rows = await db
		.prepare(
			`SELECT p.order_item_id, p.subscription_id, p.units, p.units_extended, p.iproyal_plan_id, p.days,
			 s.iproyal_order_id FROM claude_env_periods p JOIN claude_env_subscriptions s ON s.id = p.subscription_id
			 WHERE p.extend_status = 'pending' AND s.iproyal_order_state = 'ordered' AND s.iproyal_order_id IS NOT NULL
			 AND s.ip IS NOT NULL AND s.status NOT IN ('expired','cancelled')
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
				"UPDATE claude_env_periods SET extend_status = 'extending', updated_at = ? WHERE order_item_id = ? AND extend_status = 'pending'",
			)
			.bind(now, row.order_item_id)
			.run();
		if (Number(claim.meta.changes ?? 0) !== 1) continue;
		try {
			await context.iproyal.extendOrder(
				row.iproyal_order_id,
				row.iproyal_plan_id,
			);
		} catch (error) {
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
			const { text } = await subscriptionLabel(db, row.subscription_id);
			const definite = error instanceof IproyalError && error.definite;
			await context
				.deliver(
					[
						`⚠️ IPRoyal 续期${definite ? "被拒" : "结果不明"}（${errorCode(error)}）`,
						text,
						`请到 IPRoyal 后台给订单 ${row.iproyal_order_id} 手动续期${row.iproyal_plan_id === 25 ? " 90" : " 30"} 天（续费不换 IP），然后在后台「Claude 专属环境」点「已手动续期」。${definite ? "如果是余额不足，充值后点「重试续期」即可。" : ""}`,
					].join("\n"),
				)
				.catch(() => undefined);
			continue;
		}
		const done = row.units_extended + 1 >= row.units;
		await db.batch([
			db
				.prepare(
					"UPDATE claude_env_periods SET units_extended = units_extended + 1, extend_status = ?, note = NULL, updated_at = ? WHERE order_item_id = ?",
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
	}
	return { extended };
}

// ---------- 6. expiry ----------

export async function expireSubscriptions(context: Context) {
	const { db, now } = context;
	const [grace, expired] = await db.batch([
		db
			.prepare(
				"UPDATE claude_env_subscriptions SET status = 'grace', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
			)
			.bind(now, now),
		db
			.prepare(
				"UPDATE claude_env_subscriptions SET status = 'expired', updated_at = ? WHERE status = 'grace' AND expires_at IS NOT NULL AND expires_at + ? <= ?",
			)
			.bind(now, graceMs, now),
	]);
	return {
		grace: Number(grace?.meta.changes ?? 0),
		expired: Number(expired?.meta.changes ?? 0),
	};
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
		await context
			.deliver(
				`⚠️ 中转机 ${row.id} 已经 5 分钟以上没有上报（最近一次：${row.last_report_at ? `${beijing(row.last_report_at)} 北京时间` : "从未"}）。客户可能断线，请检查中转机和 ce-relay 服务。`,
			)
			.catch(() => undefined);
	}
	return rows.results.length;
}
