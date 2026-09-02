import {
	adapterForSupplierAccount,
	type SupplierAccountRuntimeRow,
} from "#/features/suppliers/server/account-runtime";
import { claimSupplierApiBudget } from "#/features/suppliers/server/rate-limit";
import {
	feishuAlertErrorCode,
	recordFeishuAlertResult,
	resolveFeishuAlertCredentials,
	sendFeishuText,
} from "#/features/telegram/server/feishu-alerts";
import { formatMinorAmountWithSymbol } from "#/lib/format";
import { loadRuntimeConfig } from "#/server/runtime-config";

export const ownerSaleAlertsSettingKey =
	"commerce.sales.feishu_alerts_enabled" as const;

type SaleAlertRow = {
	id: string;
	aggregate_id: string;
	attempt_count: number;
	order_number: string;
	order_status: string;
	currency: string;
	currency_decimals: number;
	total_minor: string;
	items_summary: string;
	supplier_item_count: number;
	manual_item_count: number;
	supplier_pending_count: number;
	supplier_failed_count: number;
	payment_channel: string | null;
};

type Balance = {
	amountMinor: string;
	currency: string;
	currencyDecimals: number;
	fresh: boolean;
};

export async function publishPendingOwnerSaleAlerts(input: {
	db: D1Database;
	limit?: number;
	now?: number;
	fetcher?: typeof fetch;
	deliver?: (text: string) => Promise<void>;
	readBalance?: () => Promise<Balance | null>;
}) {
	const now = input.now ?? Date.now();
	const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));
	const rows = await input.db
		.prepare(
			`SELECT event.id, event.aggregate_id, event.attempt_count,
			        orders.order_number, orders.status AS order_status,
			        orders.currency, orders.currency_decimals, orders.total_minor,
			        (SELECT GROUP_CONCAT(order_item.product_name || ' · ' ||
			          order_item.sellable_item_name || ' × ' || order_item.quantity, '；')
			         FROM shop_order_items order_item
			         WHERE order_item.order_id = orders.id) AS items_summary,
			        (SELECT COUNT(*) FROM shop_order_items supplier_item
			         JOIN product_sellable_items supplier_sellable
			          ON supplier_sellable.id = supplier_item.sellable_item_id
			         WHERE supplier_item.order_id = orders.id
			          AND supplier_sellable.fulfillment_source = 'supplier')
			         AS supplier_item_count,
			        (SELECT COUNT(*) FROM shop_order_items manual_item
			         JOIN product_sellable_items manual_sellable
			          ON manual_sellable.id = manual_item.sellable_item_id
			         WHERE manual_item.order_id = orders.id
			          AND manual_sellable.fulfillment_source = 'manual')
			         AS manual_item_count,
			        (SELECT COUNT(*) FROM supplier_orders pending_supplier
			         WHERE pending_supplier.order_id = orders.id
			          AND pending_supplier.state IN
			           ('pending', 'selecting', 'submitting', 'uncertain'))
			         AS supplier_pending_count,
			        (SELECT COUNT(*) FROM supplier_orders failed_supplier
			         WHERE failed_supplier.order_id = orders.id
			          AND failed_supplier.state IN ('failed', 'refunded'))
			         AS supplier_failed_count,
			        (SELECT channel.name FROM payment_attempts payment
			         JOIN payment_channels channel ON channel.id = payment.channel_id
			         WHERE payment.order_id = orders.id AND payment.status = 'succeeded'
			         ORDER BY payment.succeeded_at DESC, payment.created_at DESC,
			                  payment.id DESC LIMIT 1) AS payment_channel
			 FROM outbox_events event
			 JOIN shop_orders orders ON orders.id = event.aggregate_id
			 WHERE event.event_type = 'owner.sale_alert'
			  AND event.status = 'pending'
			  AND (event.next_attempt_at IS NULL OR event.next_attempt_at <= ?)
			 ORDER BY event.created_at, event.id LIMIT ?`,
		)
		.bind(now, limit)
		.all<SaleAlertRow>();
	let sent = 0;
	let deferred = 0;
	let failed = 0;
	for (const row of rows.results) {
		if (row.supplier_pending_count > 0) {
			await defer(input.db, row.id, now, "owner_sale_waiting_for_supplier");
			deferred += 1;
			continue;
		}
		try {
			const balance = input.readBalance
				? await input.readBalance()
				: await readAisouBalance(input.db, now, input.fetcher ?? fetch);
			const text = formatFeishuOwnerSaleAlert(row, balance, now);
			if (input.deliver) await input.deliver(text);
			else {
				const credentials = await resolveFeishuAlertCredentials(input.db, {
					requireEnabled: false,
				});
				if (!credentials) throw new Error("feishu_configuration_unavailable");
				await sendFeishuText(credentials, text, input.fetcher ?? fetch);
				await recordFeishuAlertResult(input.db, { sent: true });
			}
			await input.db
				.prepare(
					`UPDATE outbox_events SET status = 'published', published_at = ?,
					 next_attempt_at = NULL, last_error_code = NULL, updated_at = ?
					 WHERE id = ? AND status = 'pending'`,
				)
				.bind(now, now, row.id)
				.run();
			sent += 1;
		} catch (error) {
			const code = feishuAlertErrorCode(error);
			if (!input.deliver)
				await recordFeishuAlertResult(input.db, {
					sent: false,
					errorCode: code,
				});
			await retryOrFail(input.db, row, now, code);
			failed += 1;
		}
	}
	return { scanned: rows.results.length, sent, deferred, failed };
}

export function formatFeishuOwnerSaleAlert(
	row: Omit<SaleAlertRow, "id" | "aggregate_id" | "attempt_count">,
	balance: Balance | null,
	now = Date.now(),
) {
	const amount = formatMinorAmountWithSymbol(
		row.total_minor,
		row.currency,
		row.currency_decimals,
		"zh-CN",
	);
	const remaining = balance
		? `${formatMinorAmountWithSymbol(
				balance.amountMinor,
				balance.currency,
				balance.currencyDecimals,
				"zh-CN",
			)}${balance.fresh ? "" : "（缓存）"}`
		: "未配置";
	const fulfillment =
		row.supplier_failed_count > 0
			? "自动交付异常"
			: row.supplier_item_count > 0
				? "自动交付完成"
				: row.manual_item_count > 0
					? "人工采购"
					: "自动交付";
	const time = new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	})
		.format(now)
		.replaceAll("/", "-");
	return [
		"💰 老实人VIP新订单",
		`订单：${row.order_number}`,
		`商品：${row.items_summary}`,
		`实收：${amount}`,
		`支付：${row.payment_channel ?? "余额/无需支付"}`,
		`交付：${fulfillment}`,
		`Aisou剩余额度：${remaining}`,
		`时间：${time}（北京时间）`,
	].join("\n");
}

async function readAisouBalance(
	db: D1Database,
	now: number,
	fetcher: typeof fetch,
): Promise<Balance | null> {
	const account = await db
		.prepare(
			`SELECT * FROM supplier_accounts
			 WHERE provider = 'shared_stock'
			  AND normalized_api_origin = 'https://aisou.pro'
			  AND enabled = 1 ORDER BY id LIMIT 1`,
		)
		.first<
			SupplierAccountRuntimeRow & {
				normalized_api_origin: string;
				protocol_version: string;
				currency: string;
				currency_decimals: number;
				balance_minor: string | null;
			}
		>();
	if (!account) return null;
	try {
		const runtime = await loadRuntimeConfig(db);
		await claimSupplierApiBudget(db, {
			provider: account.provider,
			normalizedApiOrigin: account.normalized_api_origin,
			protocolVersion: account.protocol_version,
			accountId: account.id,
			now,
		});
		const adapter = await adapterForSupplierAccount(account, runtime, {
			fetcher,
		});
		const connection = await adapter.testConnection();
		await db
			.prepare(
				`UPDATE supplier_accounts SET balance_minor = ?, balance_synced_at = ?,
				 health_status = 'healthy', consecutive_failures = 0,
				 cooldown_until = NULL, last_error_code = NULL, updated_at = ?
				 WHERE id = ?`,
			)
			.bind(connection.balance.amountMinor, now, now, account.id)
			.run();
		return {
			amountMinor: connection.balance.amountMinor,
			currency: connection.balance.currency,
			currencyDecimals: account.currency_decimals,
			fresh: true,
		};
	} catch {
		if (account.balance_minor === null) return null;
		return {
			amountMinor: account.balance_minor,
			currency: account.currency,
			currencyDecimals: account.currency_decimals,
			fresh: false,
		};
	}
}

async function defer(db: D1Database, id: string, now: number, code: string) {
	await db
		.prepare(
			`UPDATE outbox_events SET attempt_count = attempt_count + 1,
			 next_attempt_at = ?, last_error_code = ?, updated_at = ?
			 WHERE id = ? AND status = 'pending'`,
		)
		.bind(now + 15_000, code, now, id)
		.run();
}

async function retryOrFail(
	db: D1Database,
	row: Pick<SaleAlertRow, "id" | "attempt_count">,
	now: number,
	code: string,
) {
	const attempts = row.attempt_count + 1;
	const terminal = attempts >= 10;
	await db
		.prepare(
			`UPDATE outbox_events SET status = ?, attempt_count = ?,
			 next_attempt_at = ?, last_error_code = ?, updated_at = ?
			 WHERE id = ? AND status = 'pending'`,
		)
		.bind(
			terminal ? "failed" : "pending",
			attempts,
			terminal ? null : now + Math.min(300_000, 15_000 * 2 ** (attempts - 1)),
			code,
			now,
			row.id,
		)
		.run();
}
