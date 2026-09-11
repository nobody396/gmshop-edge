import { paymentProcessingFeeAmount } from "#/features/shop-payments/fees";
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
	contact_email: string;
	items_summary: string;
	cost_total_minor: string;
	cost_missing_count: number;
	local_fulfilled_count: number;
	supplier_fulfilled_count: number;
	local_stock_remaining_summary: string | null;
	supplier_item_count: number;
	manual_item_count: number;
	supplier_pending_count: number;
	supplier_failed_count: number;
	payment_channel: string | null;
	payment_amount_minor: string | null;
	payment_currency: string | null;
	payment_currency_decimals: number | null;
	payment_fee_bps: number | null;
	payment_fixed_fee_minor: string | null;
	wallet_balance_after_minor: string | null;
	internal_supply_count: number;
	downstream_order_no: string | null;
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
			        orders.contact_email,
			        (SELECT GROUP_CONCAT(order_item.product_name || ' · ' ||
			          order_item.sellable_item_name || ' × ' || order_item.quantity, '；')
			         FROM shop_order_items order_item
			         WHERE order_item.order_id = orders.id) AS items_summary,
			        COALESCE((SELECT SUM(CASE
			          WHEN EXISTS (SELECT 1 FROM supplier_orders supplied_cost
			                       WHERE supplied_cost.order_item_id = cost_item.id
			                        AND supplied_cost.state = 'supplied')
			          THEN COALESCE((SELECT CAST(supplied_cost.total_cost_minor AS INTEGER)
			                         FROM supplier_orders supplied_cost
			                         WHERE supplied_cost.order_item_id = cost_item.id
			                          AND supplied_cost.state = 'supplied'
			                         ORDER BY supplied_cost.updated_at DESC,
			                                  supplied_cost.id DESC LIMIT 1),
			                        CAST(cost_item.unit_cost_minor AS INTEGER) * cost_item.quantity, 0)
			          ELSE COALESCE((SELECT SUM(CAST(stock_cost.unit_cost_minor AS INTEGER))
			                         FROM stock_entries stock_cost
			                         WHERE stock_cost.order_item_id = cost_item.id
			                          AND stock_cost.status IN ('reserved', 'delivered')
			                          AND stock_cost.unit_cost_minor IS NOT NULL),
			                        CAST(cost_item.unit_cost_minor AS INTEGER) * cost_item.quantity, 0)
			         END) FROM shop_order_items cost_item
			         WHERE cost_item.order_id = orders.id), 0) AS cost_total_minor,
			        (SELECT COUNT(*) FROM shop_order_items missing_cost
			         WHERE missing_cost.order_id = orders.id
			          AND NOT EXISTS (SELECT 1 FROM supplier_orders exact_supplier_cost
			                          WHERE exact_supplier_cost.order_item_id = missing_cost.id
			                           AND exact_supplier_cost.state = 'supplied'
			                           AND exact_supplier_cost.total_cost_minor IS NOT NULL)
			          AND NOT EXISTS (SELECT 1 FROM stock_entries exact_stock_cost
			                          WHERE exact_stock_cost.order_item_id = missing_cost.id
			                           AND exact_stock_cost.status IN ('reserved', 'delivered')
			                           AND exact_stock_cost.unit_cost_minor IS NOT NULL)
			          AND missing_cost.unit_cost_minor IS NULL) AS cost_missing_count,
			        (SELECT COUNT(*) FROM shop_order_items local_item
			         WHERE local_item.order_id = orders.id
			          AND EXISTS (SELECT 1 FROM stock_entries local_stock
			                      WHERE local_stock.order_item_id = local_item.id
			                       AND local_stock.status IN ('reserved', 'delivered'))
			          AND NOT EXISTS (SELECT 1 FROM supplier_orders local_supplier
			                          WHERE local_supplier.order_item_id = local_item.id))
			         AS local_fulfilled_count,
			        (SELECT COUNT(*) FROM supplier_orders supplied_source
			         WHERE supplied_source.order_id = orders.id
			          AND supplied_source.state = 'supplied') AS supplier_fulfilled_count,
			        (SELECT GROUP_CONCAT(remaining_item.name || ' ' ||
			          (SELECT COUNT(*) FROM stock_entries remaining_stock
			           WHERE remaining_stock.sellable_item_id = remaining_item.id
			            AND remaining_stock.status = 'available'), '；')
			         FROM product_sellable_items remaining_item
			         WHERE remaining_item.id IN (SELECT purchased.sellable_item_id
			          FROM shop_order_items purchased WHERE purchased.order_id = orders.id))
			         AS local_stock_remaining_summary,
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
			                  payment.id DESC LIMIT 1) AS payment_channel,
			        (SELECT payment.amount_minor FROM payment_attempts payment
			         WHERE payment.order_id = orders.id AND payment.status = 'succeeded'
			         ORDER BY payment.succeeded_at DESC, payment.created_at DESC,
			                  payment.id DESC LIMIT 1) AS payment_amount_minor,
			        (SELECT payment.currency FROM payment_attempts payment
			         WHERE payment.order_id = orders.id AND payment.status = 'succeeded'
			         ORDER BY payment.succeeded_at DESC, payment.created_at DESC,
			                  payment.id DESC LIMIT 1) AS payment_currency,
			        (SELECT payment.currency_decimals FROM payment_attempts payment
			         WHERE payment.order_id = orders.id AND payment.status = 'succeeded'
			         ORDER BY payment.succeeded_at DESC, payment.created_at DESC,
			                  payment.id DESC LIMIT 1) AS payment_currency_decimals,
			        (SELECT channel.fee_bps FROM payment_attempts payment
			         JOIN payment_channels channel ON channel.id = payment.channel_id
			         WHERE payment.order_id = orders.id AND payment.status = 'succeeded'
			         ORDER BY payment.succeeded_at DESC, payment.created_at DESC,
			                  payment.id DESC LIMIT 1) AS payment_fee_bps,
			        (SELECT channel.fixed_fee_minor FROM payment_attempts payment
			         JOIN payment_channels channel ON channel.id = payment.channel_id
			         WHERE payment.order_id = orders.id AND payment.status = 'succeeded'
			         ORDER BY payment.succeeded_at DESC, payment.created_at DESC,
			                  payment.id DESC LIMIT 1) AS payment_fixed_fee_minor,
			        (SELECT wallet.balance_after_minor FROM wallet_entries wallet
			         WHERE wallet.source_type = 'shop_order' AND wallet.source_id = orders.id
			          AND wallet.direction = 'debit'
			         ORDER BY wallet.created_at DESC, wallet.id DESC LIMIT 1)
			         AS wallet_balance_after_minor,
			        (SELECT COUNT(*) FROM supplier_api_orders internal_order
			         WHERE internal_order.shop_order_id = orders.id) AS internal_supply_count,
			        (SELECT internal_order.downstream_order_no FROM supplier_api_orders internal_order
			         WHERE internal_order.shop_order_id = orders.id LIMIT 1) AS downstream_order_no
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
	const cost =
		row.cost_missing_count > 0
			? "待核对"
			: formatMinorAmountWithSymbol(
					row.cost_total_minor,
					row.currency,
					row.currency_decimals,
					"zh-CN",
				);
	const walletPaid = row.wallet_balance_after_minor !== null;
	const actualPaid = walletPaid
		? amount
		: row.payment_amount_minor && row.payment_currency
			? formatMinorAmountWithSymbol(
					row.payment_amount_minor,
					row.payment_currency,
					row.payment_currency_decimals ?? row.currency_decimals,
					"zh-CN",
				)
			: amount;
	let fee = walletPaid ? "¥0.00（无手续费）" : "待核对";
	let netRevenueMinor = BigInt(row.total_minor);
	if (
		row.payment_amount_minor !== null &&
		row.payment_currency === row.currency &&
		row.payment_currency_decimals === row.currency_decimals
	) {
		const paymentMinor = BigInt(row.payment_amount_minor);
		const feeMinor = BigInt(
			paymentProcessingFeeAmount(
				row.payment_amount_minor,
				row.payment_fee_bps ?? 0,
				row.payment_fixed_fee_minor ?? "0",
			),
		);
		const surchargeMinor = paymentMinor - BigInt(row.total_minor);
		const customerCoveredFeeMinor = surchargeMinor > 0n ? surchargeMinor : 0n;
		const bearer =
			feeMinor === 0n
				? "无手续费"
				: customerCoveredFeeMinor >= feeMinor
					? "用户承担"
					: customerCoveredFeeMinor === 0n
						? "我们承担"
						: "用户和我们共同承担";
		fee = `${formatMinorAmountWithSymbol(
			feeMinor.toString(),
			row.currency,
			row.currency_decimals,
			"zh-CN",
		)}（${bearer}）`;
		netRevenueMinor = paymentMinor - feeMinor;
	}
	const profit =
		row.cost_missing_count > 0
			? "待核对"
			: formatMinorAmountWithSymbol(
					(netRevenueMinor - BigInt(row.cost_total_minor)).toString(),
					row.currency,
					row.currency_decimals,
					"zh-CN",
				);
	const walletRemaining = walletPaid
		? formatMinorAmountWithSymbol(
				row.wallet_balance_after_minor ?? "0",
				row.currency,
				row.currency_decimals,
				"zh-CN",
			)
		: "不适用";
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
			: row.supplier_fulfilled_count > 0 || row.supplier_item_count > 0
				? "自动交付完成"
				: row.manual_item_count > 0
					? "人工采购"
					: "自动交付";
	const cdkSource =
		row.supplier_fulfilled_count > 0 && row.local_fulfilled_count > 0
			? "混合：内置库存＋钱包额度下单"
			: row.supplier_fulfilled_count > 0
				? "钱包额度下单"
				: row.local_fulfilled_count > 0
					? "内置库存"
					: row.manual_item_count > 0
						? "人工采购"
						: "待核对";
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
	const title =
		row.internal_supply_count > 0
			? "💰 老实人VIP内部供货单"
			: "💰 老实人VIP新订单";
	return [
		title,
		`订单：${row.order_number}`,
		...(row.downstream_order_no
			? [`关联子站订单：${row.downstream_order_no}`]
			: []),
		`下单邮箱：${row.contact_email || "未填写"}`,
		`商品：${row.items_summary}`,
		`商品售价：${amount}`,
		`用户实际支付：${actualPaid}`,
		`手续费：${fee}`,
		`支付方式：${walletPaid ? "用户钱包" : (row.payment_channel ?? "无需支付")}`,
		`用户钱包剩余额度：${walletRemaining}`,
		`CDK来源：${cdkSource}`,
		`我们的成本：${cost}`,
		`${row.internal_supply_count > 0 ? "VIP供货层利润" : "我们的利润"}：${profit}`,
		...(row.internal_supply_count > 0
			? ["利润口径：已包含在lsrai.shop整单利润中，请勿重复相加"]
			: []),
		`交付：${fulfillment}`,
		`内置库存剩余：${row.local_stock_remaining_summary ?? "不适用"}`,
		`采购钱包剩余额度：${remaining}`,
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
