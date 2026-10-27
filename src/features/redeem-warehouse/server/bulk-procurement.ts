import { z } from "zod";
import { claimInterval } from "#/features/ops-automation/server/shared";
import {
	type OwnerActionContext,
	proposeOwnerAction,
} from "#/features/telegram/server/owner-actions";
import { sendOwnerAlert } from "#/features/telegram/server/owner-alerts";
import { DomainError } from "#/lib/domain-error";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { generateRedeemSellableInventory } from "./admin";
import { saleComponents } from "./sale-capacity";
import {
	loadDeliveryWarehouseToken,
	requestWarehouse,
} from "./warehouse-client";

/**
 * Bulk sales: an order line of at least three owned codes asks the redeem
 * warehouse to buy its cards from AISOU in one wholesale trade (see the
 * warehouse's docs/aisou-bulk.md). The customer already holds the codes; this
 * only decides when and at what price the cards are bought. Every outcome is
 * reported to the owner on Telegram, with buttons when the owner must act.
 */
export const bulkMinimumQuantity = 3;
const maxTransientAttempts = 15;
const verifyPollMs = 60_000;
// A trade in review may still deliver (the warehouse reads it again every minute); its result is followed slowly.
const reviewPollMs = 5 * 60_000;
const awaitingStates = ["awaiting_funds", "awaiting_stock", "awaiting_price"];
const rowColumns = `b.id, b.order_id, b.order_item_id, b.warehouse_sku, b.quantity,
	b.code_hashes_json, b.state, b.accept_unit_minor, b.attempt_count, b.notified_state, b.last_result_json,
	o.order_number, o.status AS order_status, o.total_minor,
	i.product_name, i.sellable_item_name, c.name AS channel_name`;
const rowJoins = `FROM bulk_procurements b
	JOIN shop_orders o ON o.id = b.order_id
	JOIN shop_order_items i ON i.id = b.order_item_id
	LEFT JOIN payment_channels c ON c.id = o.pricing_channel_id`;

const resultSchema = z.looseObject({
	status: z.string(),
	need: z.number().int().nonnegative().optional(),
	sold: z.number().int().nonnegative().optional(),
	stock: z.number().optional(),
	minQuantity: z.number().int().nullable().optional(),
	unitFen: z.number().int().optional(),
	expectedUnitFen: z.number().int().optional(),
	totalFen: z.number().int().optional(),
	balanceFen: z.number().int().optional(),
	trade_no: z.string().nullable().optional(),
	amount: z.string().nullable().optional(),
	quoted_total: z.string().nullable().optional(),
	ready: z.number().int().optional(),
	quarantined: z.number().int().optional(),
	reason: z.string().nullable().optional(),
	balance_after: z.string().nullable().optional(),
});
type BulkResult = z.infer<typeof resultSchema>;
const envelopeSchema = z.object({
	success: z.literal(true),
	data: resultSchema,
});

type BulkRow = {
	id: string;
	order_id: string;
	order_item_id: string;
	warehouse_sku: string;
	quantity: number;
	code_hashes_json: string;
	state: string;
	accept_unit_minor: string | null;
	attempt_count: number;
	notified_state: string | null;
	order_number: string;
	order_status: string;
	total_minor: string;
	product_name: string;
	sellable_item_name: string;
	channel_name: string | null;
};

/** Called once per delivered order line of owned codes; a line below the bulk size is ignored. */
export async function recordBulkSale(
	db: D1Database,
	input: {
		orderId: string;
		orderItemId: string;
		sellableItemId: string;
		sku: string;
		codeHashes: string[];
		now?: number;
	},
) {
	if (input.codeHashes.length < bulkMinimumQuantity) return;
	const now = input.now ?? Date.now();
	await db
		.prepare(
			`INSERT OR IGNORE INTO bulk_procurements
			 (id, order_id, order_item_id, sellable_item_id, warehouse_sku, quantity,
			  code_hashes_json, state, next_attempt_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			input.orderId,
			input.orderItemId,
			input.sellableItemId,
			input.sku,
			input.codeHashes.length,
			JSON.stringify(input.codeHashes.slice(0, 50)),
			now,
			now,
		)
		.run();
}

/** Minute cron: advances due bulk sales one warehouse call each. */
export async function runBulkProcurements(input: {
	db: D1Database;
	now: number;
	fetcher?: typeof fetch;
	requester?: typeof requestWarehouse;
}) {
	const { db, now } = input;
	const requester = input.requester ?? requestWarehouse;
	let token: string | null = null;
	const warehouseToken = async () => {
		if (token) return token;
		const runtime = await loadRuntimeConfig(db);
		if (!runtime.commerceSecret) return null;
		token = await loadDeliveryWarehouseToken(db, runtime.commerceSecret);
		return token;
	};
	// The warehouse keeps a bulk line's codes for its wholesale trade only. They are released for single
	// purchases when the owner presses "这批不进了", or when the order was refunded before the trade.
	const giveUps = await db
		.prepare(
			`SELECT b.id, b.state, CASE WHEN o.status IN ('refunding','refunded','cancelled') THEN 'cancelled' ELSE 'skipped' END AS next_state
			 FROM bulk_procurements b JOIN shop_orders o ON o.id = b.order_id
			 WHERE b.state IN ('pending','awaiting_funds','awaiting_stock','awaiting_price')
			  AND (b.owner_action_id IN (SELECT id FROM owner_action_requests WHERE status = 'rejected')
			   OR o.status IN ('refunding','refunded','cancelled'))
			 LIMIT 10`,
		)
		.all<{ id: string; state: string; next_state: string }>();
	for (const row of giveUps.results) {
		const key = await warehouseToken();
		if (!key) break;
		try {
			await requester(key, "/api/internal/aisou/bulk", {
				method: "POST",
				body: JSON.stringify({ batch_id: row.id, release: true }),
			});
		} catch {
			continue; // Released on the next minute; the line keeps its state meanwhile.
		}
		await db
			.prepare(
				"UPDATE bulk_procurements SET state = ?, updated_at = ? WHERE id = ? AND state = ?",
			)
			.bind(row.next_state, now, row.id, row.state)
			.run();
	}
	// Messages that did not go out (Telegram down) are sent again.
	const unsent = await db
		.prepare(
			`SELECT ${rowColumns} ${rowJoins}
			 WHERE b.state NOT IN ('pending','verifying') AND (b.notified_state IS NULL OR b.notified_state <> b.state)
			 ORDER BY b.updated_at LIMIT 5`,
		)
		.all<BulkRow & { last_result_json: string | null }>();
	for (const row of unsent.results) {
		let result: BulkResult = { status: row.state };
		try {
			result = resultSchema.parse(JSON.parse(row.last_result_json ?? "{}"));
		} catch {
			// The message falls back to the state alone.
		}
		await notify(db, row, row.state, result, now, input.fetcher);
	}
	const due = await db
		.prepare(
			`SELECT b.id, b.order_id, b.order_item_id, b.warehouse_sku, b.quantity,
			 b.code_hashes_json, b.state, b.accept_unit_minor, b.attempt_count, b.notified_state,
			 o.order_number, o.status AS order_status, o.total_minor,
			 i.product_name, i.sellable_item_name, c.name AS channel_name
			 FROM bulk_procurements b
			 JOIN shop_orders o ON o.id = b.order_id
			 JOIN shop_order_items i ON i.id = b.order_item_id
			 LEFT JOIN payment_channels c ON c.id = o.pricing_channel_id
			 WHERE b.state IN ('pending','verifying','review') AND b.next_attempt_at <= ?
			 ORDER BY b.next_attempt_at, b.created_at LIMIT 5`,
		)
		.bind(now)
		.all<BulkRow>();
	if (due.results.length === 0)
		return { status: "idle" as const, processed: 0 };
	const key = await warehouseToken();
	if (!key) return { status: "unavailable" as const };
	for (const row of due.results)
		await advance(db, row, key, now, requester, input.fetcher);
	return { status: "ran" as const, processed: due.results.length };
}

async function advance(
	db: D1Database,
	row: BulkRow,
	token: string,
	now: number,
	requester: typeof requestWarehouse,
	fetcher: typeof fetch | undefined,
) {
	if (
		["refunding", "refunded", "cancelled"].includes(row.order_status) &&
		row.state === "pending"
	)
		return settle(db, row, "cancelled", { status: "cancelled" }, now, fetcher);
	let result: BulkResult;
	try {
		const body = envelopeSchema.parse(
			await requester(token, "/api/internal/aisou/bulk", {
				method: "POST",
				body: JSON.stringify({
					batch_id: row.id,
					code_hashes: JSON.parse(row.code_hashes_json),
					...(row.accept_unit_minor
						? { accept_unit_fen: Number(row.accept_unit_minor) }
						: {}),
				}),
			}),
		);
		result = body.data;
	} catch {
		result = { status: "warehouse_unreachable" };
	}
	switch (result.status) {
		case "verifying":
			return settle(
				db,
				row,
				"verifying",
				result,
				now,
				fetcher,
				now + verifyPollMs,
			);
		case "supplied":
			return settle(db, row, "supplied", result, now, fetcher);
		case "review":
			return settle(db, row, "review", result, now, fetcher, now + reviewPollMs);
		case "funds_short":
		case "failed":
			return settle(db, row, "awaiting_funds", result, now, fetcher);
		case "stock_short":
			return settle(db, row, "awaiting_stock", result, now, fetcher);
		case "price_changed":
			return settle(db, row, "awaiting_price", result, now, fetcher);
		case "below_tier":
		case "nothing_needed":
		case "not_bulk":
			return settle(db, row, "skipped", result, now, fetcher);
		default: {
			// in_progress, supplier_unreachable, disabled, warehouse_unreachable: try again later.
			const attempts = row.attempt_count + 1;
			if (attempts >= maxTransientAttempts)
				return settle(
					db,
					row,
					"review",
					{ ...result, reason: `${result.status} after ${attempts} tries` },
					now,
					fetcher,
				);
			await db
				.prepare(
					`UPDATE bulk_procurements SET attempt_count = ?, next_attempt_at = ?,
					 last_result_json = ?, updated_at = ? WHERE id = ? AND state = ?`,
				)
				.bind(
					attempts,
					now + Math.min(10, attempts) * 60_000,
					JSON.stringify(result),
					now,
					row.id,
					row.state,
				)
				.run();
		}
	}
}

async function settle(
	db: D1Database,
	row: BulkRow,
	state: string,
	result: BulkResult,
	now: number,
	fetcher: typeof fetch | undefined,
	nextAttemptAt = 0,
) {
	const changed = await db
		.prepare(
			`UPDATE bulk_procurements SET state = ?, last_result_json = ?, next_attempt_at = ?,
			 updated_at = ? WHERE id = ? AND state = ?`,
		)
		.bind(state, JSON.stringify(result), nextAttemptAt, now, row.id, row.state)
		.run();
	if (Number(changed.meta.changes ?? 0) !== 1 || row.notified_state === state)
		return;
	// A silent skip: the line is not a bulk SKU at all.
	if (result.status === "not_bulk") {
		await db
			.prepare("UPDATE bulk_procurements SET notified_state = ? WHERE id = ?")
			.bind(state, row.id)
			.run();
		return;
	}
	await notify(db, row, state, result, now, fetcher);
}

/**
 * Tells the owner about `state`, recording it only once a message actually
 * went out; the minute cron resends anything not yet delivered.
 */
async function notify(
	db: D1Database,
	row: BulkRow,
	state: string,
	result: BulkResult,
	now: number,
	fetcher: typeof fetch | undefined,
) {
	const message = describe(row, state, result);
	let delivered = false;
	let actionId: string | null = null;
	try {
		if (awaitingStates.includes(state)) {
			const proposal = await proposeOwnerAction(db, {
				kind: "bulk_procurement",
				payload: {
					id: row.id,
					...(state === "awaiting_price" && result.unitFen
						? { acceptUnitMinor: String(result.unitFen) }
						: {}),
				},
				text: message,
				choices: [
					state === "awaiting_stock"
						? "✅ 已补货，重新进货"
						: state === "awaiting_price"
							? `✅ 按 ¥${yuan(result.unitFen)}/张进货`
							: "✅ 已充值，重新进货",
				],
				rejectLabel: "🚫 这批不进了（兑换时单张进货）",
				fallback: null,
				now,
				fetcher,
			});
			actionId = proposal?.id ?? null;
			// Without a working button webhook the text still goes out as a plain alert;
			// only a message that actually went out counts.
			delivered =
				proposal !== null ||
				(await sendOwnerAlert(
					db,
					`${message}\n\n（Telegram 按钮暂时不可用：处理好后让 Claude 把这批改回待进货即可）`,
					{ fetcher, topic: "restock" },
				)) !== null;
		} else
			delivered =
				(await sendOwnerAlert(db, message, {
					fetcher,
					topic: "restock",
				})) !== null;
	} catch {
		delivered = false;
	}
	if (!delivered) return;
	await db
		.prepare(
			"UPDATE bulk_procurements SET notified_state = ?, owner_action_id = COALESCE(?, owner_action_id) WHERE id = ? AND state = ?",
		)
		.bind(state, actionId, row.id, state)
		.run();
}

function describe(row: BulkRow, state: string, result: BulkResult) {
	const head = [
		`📦 批量拿货｜${row.product_name}${row.sellable_item_name && row.sellable_item_name !== row.product_name ? `｜${row.sellable_item_name}` : ""} ×${row.quantity}`,
		`订单 ${row.order_number}｜实收 ¥${yuan(Number(row.total_minor))}${row.channel_name ? `（${row.channel_name}）` : ""}`,
	];
	const need = result.need ?? row.quantity;
	const body = (() => {
		switch (state) {
			case "verifying":
				return `✅ 已从 AISOU 一次进货 ${need} 张，实扣 ¥${result.amount ?? "?"}（报价 ¥${result.quoted_total ?? "?"}），AISOU 余额 ¥${result.balance_after ?? "?"}。\n正在逐张验卡（约 3 秒一张），验完另报。客户已拿到卡密，可随时兑换。`;
			case "supplied":
				return `✅ 验卡完成：${result.ready ?? need} 张全部可用，已绑定给这批卡密。AISOU 订单 ${result.trade_no ?? "-"}，实扣 ¥${result.amount ?? "?"}。`;
			case "review":
				return `⚠️ 需要人工核对：${result.reason ?? result.status}。\nAISOU 订单 ${result.trade_no ?? "（无）"}，实扣 ¥${result.amount ?? "?"}。已买到的卡都保留着，系统不会再为这批重买。`;
			case "awaiting_funds":
				return result.status === "failed"
					? `⚠️ AISOU 拒绝了这次下单：${result.reason ?? "未说明"}。没有扣款。处理好后点下面的按钮重新进货。`
					: `💰 AISOU 余额 ¥${yuan(result.balanceFen)}，这批 ${need} 张按批发价 ¥${yuan(result.unitFen)}/张共 ¥${yuan(result.totalFen)}，还差 ¥${yuan((result.totalFen ?? 0) - (result.balanceFen ?? 0))}。\n充值后点「已充值，重新进货」。补进之前客户来兑换的卡会单张进货，不影响客户。`;
			case "awaiting_stock":
				return `📉 AISOU 这款只剩 ${result.stock ?? 0} 张，这批要 ${need} 张，一张都没进。\n请让 AISOU 补货，补好后点「已补货，重新进货」。`;
			case "awaiting_price":
				return `⚠️ AISOU 报价变了：${need} 张报 ¥${yuan(result.totalFen)}（¥${yuan(result.unitFen)}/张），公布的批发价是 ¥${yuan(result.expectedUnitFen)}/张，没有进货。`;
			case "skipped":
				return result.status === "below_tier"
					? `ℹ️ 这批里只剩 ${need} 张还没兑换，不到 AISOU 批发起订量（${result.minQuantity ?? bulkMinimumQuantity} 张），改为客户兑换时单张进货。`
					: "ℹ️ 这批卡密都已兑换或已有卡，无需进货。";
			case "cancelled":
				return "ℹ️ 订单已退款，这批不进货。";
			default:
				return result.status;
		}
	})();
	return [...head, body].join("\n");
}

function yuan(minor: number | undefined) {
	return ((minor ?? 0) / 100).toFixed(2);
}

const approvalSchema = z.object({
	id: z.string().min(1).max(64),
	acceptUnitMinor: z.string().regex(/^\d+$/).optional(),
});

/** "已充值 / 已补货 / 按新价进货": the next cron minute checks AISOU again and buys. */
export async function approveBulkProcurement(
	context: OwnerActionContext,
	rawPayload: unknown,
) {
	const payload = approvalSchema.parse(rawPayload);
	const changed = await context.db
		.prepare(
			`UPDATE bulk_procurements SET state = 'pending', next_attempt_at = 0,
			 attempt_count = 0, notified_state = NULL, owner_action_id = NULL,
			 accept_unit_minor = COALESCE(?, accept_unit_minor), updated_at = ?
			 WHERE id = ? AND state IN ('awaiting_funds','awaiting_stock','awaiting_price')`,
		)
		.bind(payload.acceptUnitMinor ?? null, context.now, payload.id)
		.run();
	if (Number(changed.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"bulk_procurement_not_waiting",
			409,
			"这批已经处理过了",
		);
	return "⏳ 已收到：1 分钟内重新检查 AISOU 并进货，结果另发一条消息";
}

const codeTopUpFloor = 100;
const codeTopUpTarget = 150;
const codeTopUpKey = "ops.bulk_code_topup.at";

/**
 * Keeps at least 100 unsold owned codes on every plan sold in bulk (one with
 * volume steps), so a 50-card order never fails for lack of codes. Codes cost
 * nothing until redeemed: the warehouse buys a card only when one is used.
 */
export async function topUpBulkCodeStock(input: {
	db: D1Database;
	now: number;
	generate?: typeof generateRedeemSellableInventory;
}) {
	const { db, now } = input;
	if (!(await claimInterval(db, codeTopUpKey, now, 10 * 60_000)))
		return { status: "waiting" as const };
	const components = await saleComponents(db);
	const rows = await db
		.prepare(
			`SELECT item.id, (SELECT COUNT(*) FROM stock_entries s WHERE s.sellable_item_id = item.id AND s.status = 'available') AS available
			 FROM product_sellable_items item JOIN products product ON product.id = item.product_id
			 WHERE item.enabled = 1 AND item.fulfillment_source = 'local' AND product.status = 'active'
			  AND EXISTS (SELECT 1 FROM sellable_item_volume_prices v WHERE v.sellable_item_id = item.id)`,
		)
		.all<{ id: string; available: number }>();
	const short = rows.results.filter(
		(row) => components[row.id] && Number(row.available) < codeTopUpFloor,
	);
	if (short.length === 0) return { status: "full" as const, generated: 0 };
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret) return { status: "unavailable" as const };
	const generate = input.generate ?? generateRedeemSellableInventory;
	let generated = 0;
	for (const row of short) {
		const count = Math.min(100, codeTopUpTarget - Number(row.available));
		await generate(
			{
				requestRef: `bulk-topup-${row.id.slice(0, 8)}-${now}`,
				sku: components[row.id] as string,
				componentId: row.id,
				count,
			},
			{
				db,
				currentUser: { id: null },
				request: new Request("https://internal.invalid/bulk-code-topup"),
				runtime: { commerceSecret: runtime.commerceSecret },
			},
		)
			.then(() => {
				generated += count;
			})
			.catch(() => undefined);
	}
	return { status: "ran" as const, generated };
}
