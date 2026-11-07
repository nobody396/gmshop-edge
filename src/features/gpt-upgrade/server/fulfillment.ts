import { activateEntitlementGrantStatements } from "#/features/entitlements/server/ledger";
import { encryptDeliveryContent } from "#/features/fulfillment/secrets";
import {
	loadDeliveryWarehouseToken,
	requestWarehouse,
} from "#/features/redeem-warehouse/server/warehouse-client";
import { sendOwnerAlert } from "#/features/telegram/server/owner-alerts";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { upgradePaidResponseSchema } from "./client";

type UpgradeOrder = {
	order_item_id: string;
	quote_token_encrypted: string;
	state: string;
	attempt_count: number;
	next_attempt_at: number;
	order_id: string;
	order_number: string;
	order_status: string;
	paid_minor: string;
	refund_exists: number;
};
const deliverable = `EXISTS(SELECT 1 FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE oi.id=gpt_upgrade_orders.order_item_id AND o.status IN ('paid','fulfilling') AND o.paid_minor<>'0' AND NOT EXISTS(SELECT 1 FROM refunds r WHERE r.order_id=o.id AND r.status IN ('pending','processing','succeeded')))`;

export function upgradeDeliveryContent(statusUrl: string) {
	return `升级已开始处理，一般 1–10 分钟完成。\n进度查看：${statusUrl}\n如显示「需人工处理」，请联系购买店铺的客服，不要重复下单。`;
}

export async function processUpgradeDelivery(
	db: D1Database,
	deliveryId: string,
) {
	const row = await db
		.prepare(`SELECT u.*,oi.order_id,o.order_number,o.status AS order_status,o.paid_minor,
	 EXISTS(SELECT 1 FROM refunds r WHERE r.order_id=o.id AND r.status IN ('pending','processing','succeeded')) AS refund_exists
	 FROM gpt_upgrade_orders u JOIN shop_order_items oi ON oi.id=u.order_item_id JOIN shop_orders o ON o.id=oi.order_id
	 JOIN delivery_records d ON d.order_item_id=u.order_item_id WHERE d.id=?`)
		.bind(deliveryId)
		.first<UpgradeOrder>();
	if (!row) return null;
	if (
		row.order_status === "refunded" ||
		row.refund_exists ||
		!["paid", "fulfilling", "completed"].includes(row.order_status) ||
		row.paid_minor === "0"
	)
		return { status: "waiting" };
	if (row.state === "delivered") return { status: "delivered" };
	if (row.state !== "pending") return { status: row.state };
	if (row.next_attempt_at > Date.now()) return { status: "processing" };
	if (row.attempt_count >= 8)
		return recordUpgradeFailure(
			db,
			row,
			deliveryId,
			"upgrade_delivery_exhausted",
			Date.now(),
		);
	const now = Date.now();
	const lease = await db
		.prepare(
			`UPDATE gpt_upgrade_orders SET attempt_count=attempt_count+1,next_attempt_at=?,updated_at=? WHERE order_item_id=? AND state='pending' AND next_attempt_at<=? AND attempt_count<8 AND ${deliverable}`,
		)
		.bind(now + 60_000, now, row.order_item_id, now)
		.run();
	if (!lease.meta.changes) return { status: "processing" };
	try {
		const { commerceSecret } = await loadRuntimeConfig(db);
		const quoteToken = await decryptSecret(
			row.quote_token_encrypted,
			commerceSecret,
			"gpt-upgrade-quote",
		);
		const result = upgradePaidResponseSchema.parse(
			await requestWarehouse(
				await loadDeliveryWarehouseToken(db, commerceSecret),
				"/api/internal/upgrade/paid",
				{
					method: "POST",
					body: JSON.stringify({
						quote_token: quoteToken,
						order_number: row.order_number,
						order_item_id: row.order_item_id,
						paid_minor: row.paid_minor,
					}),
				},
			),
		).data;
		const encrypted = await encryptDeliveryContent(
			upgradeDeliveryContent(result.status_url),
			commerceSecret,
		);
		const complete = Date.now();
		await db.batch([
			db
				.prepare(
					`UPDATE gpt_upgrade_orders SET state='delivered',status_url=?,error_code=NULL,updated_at=? WHERE order_item_id=? AND state='pending' AND ${deliverable}`,
				)
				.bind(result.status_url, complete, row.order_item_id),
			db
				.prepare(
					`UPDATE delivery_records SET status='delivered',content_encrypted=?,content_key_version=1,error_code=NULL,next_attempt_at=NULL,delivered_at=?,updated_at=? WHERE id=? AND status IN ('pending','processing') AND EXISTS(SELECT 1 FROM gpt_upgrade_orders u WHERE u.order_item_id=delivery_records.order_item_id AND u.state='delivered')`,
				)
				.bind(encrypted, complete, complete, deliveryId),
			...activateEntitlementGrantStatements(db, row.order_item_id, complete),
			db
				.prepare(
					`UPDATE shop_orders SET status='completed',completed_at=?,version=version+1,updated_at=? WHERE id=? AND status IN ('paid','fulfilling') AND NOT EXISTS(SELECT 1 FROM delivery_records d JOIN shop_order_items oi ON oi.id=d.order_item_id WHERE oi.order_id=shop_orders.id AND d.status<>'delivered')`,
				)
				.bind(complete, complete, row.order_id),
			db
				.prepare(
					`INSERT OR IGNORE INTO shop_order_events(id,order_id,event_type,visibility,to_status,order_version,actor_type,created_at) SELECT ?,id,'delivery_progressed','customer','completed',version,'system',? FROM shop_orders WHERE id=? AND status='completed'`,
				)
				.bind(`gpt-upgrade:${row.order_item_id}`, complete, row.order_id),
			db
				.prepare(
					`INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,idempotency_key,payload,status,attempt_count,created_at,updated_at) SELECT ?,'delivery.ready','delivery',?,?,?,'pending',0,?,? FROM delivery_records WHERE id=? AND status='delivered' ON CONFLICT(idempotency_key) DO NOTHING`,
				)
				.bind(
					crypto.randomUUID(),
					deliveryId,
					`delivery-ready:${deliveryId}`,
					JSON.stringify({ deliveryId, orderId: row.order_id }),
					complete,
					complete,
					deliveryId,
				),
		]);
		const actual = await db
			.prepare("SELECT state FROM gpt_upgrade_orders WHERE order_item_id=?")
			.bind(row.order_item_id)
			.first<{ state: string }>();
		return { status: actual?.state === "delivered" ? "delivered" : "waiting" };
	} catch (error) {
		return recordUpgradeFailure(
			db,
			row,
			deliveryId,
			error instanceof DomainError ? error.code : "upgrade_delivery_pending",
			now,
		);
	}
}

async function recordUpgradeFailure(
	db: D1Database,
	row: UpgradeOrder,
	deliveryId: string,
	code: string,
	now: number,
) {
	const terminal =
		[
			"redeem_warehouse_http_409_upgrade.quote_already_paid",
			"redeem_warehouse_http_409_upgrade.amount_mismatch",
		].includes(code) || row.attempt_count + 1 >= 8;
	const next = now + Math.min(3_600_000, 60_000 * 2 ** row.attempt_count);
	const [updated] = await db.batch([
		db
			.prepare(
				`UPDATE gpt_upgrade_orders SET state=?,error_code=?,next_attempt_at=?,updated_at=? WHERE order_item_id=? AND state='pending'`,
			)
			.bind(
				terminal ? "needs_review" : "pending",
				code,
				next,
				Date.now(),
				row.order_item_id,
			),
		db
			.prepare(
				`UPDATE delivery_records SET status=?,error_code=?,attempt_count=attempt_count+1,next_attempt_at=?,updated_at=? WHERE id=? AND status IN ('pending','processing')`,
			)
			.bind(
				terminal ? "failed" : "processing",
				code,
				terminal ? null : next,
				Date.now(),
				deliveryId,
			),
	]);
	if (terminal) {
		// The durable error survives an unconfigured/failed operations notification.
		if (Number(updated?.meta.changes ?? 0) > 0)
			await sendOwnerAlert(
				db,
				`⚠️ ChatGPT 升级需要人工处理\n订单：${row.order_number}\n原因：${code}\n先核对是否已扣上游钱包，再决定在卡网后台退款；不要让客户重复下单。`,
			).catch(() => undefined);
		return { status: "needs_review" };
	}
	throw new DomainError(
		"upgrade_delivery_pending",
		503,
		"Upgrade delivery is pending; do not pay again",
	);
}

// Queue duplicates can arrive during backoff and get acknowledged. The minute
// scheduler recovers due attempts (and queue loss) without bypassing the lease.
export async function reconcileUpgradeDeliveries(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT d.id FROM gpt_upgrade_orders u JOIN delivery_records d ON d.order_item_id=u.order_item_id JOIN shop_order_items oi ON oi.id=u.order_item_id JOIN shop_orders o ON o.id=oi.order_id WHERE u.state='pending' AND u.next_attempt_at<=? AND o.status IN ('paid','fulfilling') ORDER BY u.next_attempt_at,u.order_item_id LIMIT 20`,
		)
		.bind(Date.now())
		.all<{ id: string }>();
	for (const row of rows.results)
		await processUpgradeDelivery(db, row.id).catch(() => undefined);
	return { checked: rows.results.length };
}
