import { processAgentDelivery } from "#/features/agent-access/server/fulfillment";
import { activateEntitlementGrantStatements } from "#/features/entitlements/server/ledger";
import {
	decryptDeliveryContent,
	encryptDeliveryContent,
} from "#/features/fulfillment/secrets";
import {
	type ConvertibleStock,
	convertReservedStock,
} from "#/features/redeem-warehouse/server/convert-delivery";
import { notifyWarehouseSale } from "#/features/redeem-warehouse/server/sale-capacity";
import { loadDeliveryWarehouseToken } from "#/features/redeem-warehouse/server/warehouse-client";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";

type DeliveryContext = {
	id: string;
	status: "pending" | "processing" | "delivered" | "failed";
	delivery_type: "stock" | "download" | "automation";
	content_encrypted: string | null;
	order_item_id: string;
	order_id: string;
	order_status: string;
	order_version: number;
	quantity: number;
	redeem_sku: string | null;
};

export async function processDelivery(db: D1Database, deliveryId: string) {
	const agentDelivery = await processAgentDelivery(db, deliveryId);
	if (agentDelivery) return agentDelivery;
	const delivery = await db
		.prepare(
			`SELECT dr.id, dr.status, dr.delivery_type, dr.content_encrypted,
			 dr.order_item_id,
			 oi.order_id, oi.quantity, dr.redeem_sku, o.status AS order_status, o.version AS order_version
			 FROM delivery_records dr JOIN shop_order_items oi ON oi.id = dr.order_item_id
			 JOIN shop_orders o ON o.id = oi.order_id WHERE dr.id = ? LIMIT 1`,
		)
		.bind(deliveryId)
		.first<DeliveryContext>();
	if (!delivery)
		throw new DomainError("delivery_not_found", 404, "Delivery not found");
	if (delivery.status === "delivered")
		return { id: delivery.id, status: "delivered", duplicate: true };
	if (delivery.status === "failed")
		throw new DomainError(
			"delivery_failed",
			409,
			"Delivery requires administrator recovery",
		);
	// Only a paid order that is still being fulfilled may receive content; a
	// refunded order must never be delivered or flipped back to completed.
	if (!deliverableOrderStatuses.includes(delivery.order_status)) {
		if (closedOrderStatuses.includes(delivery.order_status))
			return closeUndeliverableDelivery(db, delivery.id);
		throw new DomainError(
			"delivery_order_not_ready",
			409,
			"Order is not ready for delivery",
		);
	}
	const now = Date.now();
	let contentEncrypted = delivery.content_encrypted;
	let soldEntries: { id: string; plaintext: string }[] = [];
	if (delivery.delivery_type === "stock") {
		const runtime = await loadRuntimeConfig(db);
		if (!runtime.commerceSecret)
			throw new DomainError(
				"delivery_secret_unavailable",
				503,
				"Delivery configuration unavailable",
			);
		const entries = await db
			.prepare(
				`SELECT id, content_encrypted, content_fingerprint, unit_cost_minor, redeem_sku FROM stock_entries
				 WHERE order_item_id = ? AND status = 'reserved' ORDER BY created_at, id`,
			)
			.bind(delivery.order_item_id)
			.all<ConvertibleStock>();
		if (entries.results.length !== delivery.quantity)
			throw new DomainError(
				"delivery_inventory_invalid",
				409,
				"Reserved inventory is incomplete",
			);
		let plaintext: string[];
		if (delivery.redeem_sku) {
			let currentStockId: string | null = null;
			try {
				const token = await loadDeliveryWarehouseToken(
					db,
					runtime.commerceSecret,
				);
				plaintext = [];
				for (const [index, entry] of entries.results.entries()) {
					currentStockId = entry.id;
					if (index > 0 && !entry.redeem_sku)
						await new Promise((resolve) => setTimeout(resolve, 3_100));
					plaintext.push(
						await convertReservedStock(
							db,
							entry,
							delivery.order_item_id,
							delivery.redeem_sku,
							runtime.commerceSecret,
							token,
						),
					);
				}
			} catch (error) {
				await recordOwnedDeliveryFailure(
					db,
					delivery.id,
					delivery.redeem_sku,
					"conversion",
					error,
					currentStockId,
				);
				throw error;
			}
		} else {
			plaintext = await Promise.all(
				entries.results.map((entry) =>
					decryptSecret(
						entry.content_encrypted,
						runtime.commerceSecret,
						"stock-entry",
					),
				),
			);
		}
		soldEntries = entries.results.map((entry, index) => ({
			id: entry.id,
			plaintext: plaintext[index] ?? "",
		}));
		contentEncrypted = await encryptDeliveryContent(
			plaintext.join("\n"),
			runtime.commerceSecret,
		);
	}

	const nextStatus = await nextOrderStatus(db, delivery.order_id, delivery.id);
	const nextVersion = delivery.order_version + 1;
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE delivery_records SET status = 'delivered', content_encrypted = ?,
			 content_key_version = CASE WHEN ? IS NULL THEN NULL ELSE 1 END,
			 attempt_count = attempt_count + 1, next_attempt_at = NULL, error_code = NULL,
			 delivered_at = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'processing') AND EXISTS (SELECT 1 FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE oi.id=delivery_records.order_item_id AND o.status IN ('paid','fulfilling'))${delivery.redeem_sku ? " AND (SELECT COUNT(*) FROM stock_entries s WHERE s.order_item_id=delivery_records.order_item_id AND s.status='reserved' AND s.redeem_sku=delivery_records.redeem_sku)=(SELECT quantity FROM shop_order_items WHERE id=delivery_records.order_item_id)" : ""}`,
			)
			.bind(contentEncrypted, contentEncrypted, now, now, delivery.id),
		// D1 batches are transactions. A failed delivery CAS (for example an
		// order refunded meanwhile) must abort BEFORE stock, outbox or
		// entitlement writes; throwing after batch completion is too late.
		db
			.prepare(
				`SELECT CASE WHEN EXISTS (SELECT 1 FROM delivery_records WHERE id=? AND status='delivered') THEN 1 ELSE json_extract('${delivery.redeem_sku ? "redeem_delivery_conflict" : "delivery_conflict"}','$') END`,
			)
			.bind(delivery.id),
	];

	if (delivery.delivery_type === "stock")
		statements.push(
			db
				.prepare(
					`UPDATE stock_entries SET status = 'delivered', delivered_at = ?, updated_at = ?
				 WHERE order_item_id = ? AND status = 'reserved'`,
				)
				.bind(now, now, delivery.order_item_id),
		);
	statements.push(
		db
			.prepare(
				`UPDATE shop_orders SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
			 version = ?, updated_at = ? WHERE id = ? AND status = ? AND version = ?`,
			)
			.bind(
				nextStatus,
				nextStatus,
				now,
				nextVersion,
				now,
				delivery.order_id,
				delivery.order_status,
				delivery.order_version,
			),
		db
			.prepare(
				`INSERT INTO shop_order_events
			 (id, order_id, event_type, visibility, from_status, to_status, order_version,
			  actor_type, created_at)
			 SELECT ?, id, 'delivery_progressed', 'customer', ?, ?, ?, 'system', ?
			 FROM shop_orders WHERE id = ? AND status = ? AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				delivery.order_status,
				nextStatus,
				nextVersion,
				now,
				delivery.order_id,
				nextStatus,
				nextVersion,
			),
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'delivery.ready', 'delivery', ?, ?, ?, 'pending', 0, ?, ?
				 FROM delivery_records WHERE id = ? AND status = 'delivered'
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(
				crypto.randomUUID(),
				delivery.id,
				`delivery-ready:${delivery.id}`,
				JSON.stringify({
					deliveryId: delivery.id,
					orderId: delivery.order_id,
				}),
				now,
				now,
				delivery.id,
			),
		db
			.prepare(
				`UPDATE outbox_events SET status = 'published', published_at = ?, updated_at = ?
			 WHERE event_type = 'delivery.requested' AND aggregate_type = 'delivery'
			 AND aggregate_id = ? AND status IN ('pending', 'processing')`,
			)
			.bind(now, now, delivery.id),
	);
	if (delivery.delivery_type === "stock")
		statements.push(
			...activateEntitlementGrantStatements(db, delivery.order_item_id, now),
		);
	let results: D1Result<unknown>[];
	try {
		results = await db.batch(statements);
	} catch (error) {
		if (delivery.redeem_sku)
			await recordOwnedDeliveryFailure(
				db,
				delivery.id,
				delivery.redeem_sku,
				"finalization",
				error,
			);
		throw error;
	}

	if (Number(results[0]?.meta.changes ?? 0) < 1)
		return { id: delivery.id, status: "delivered", duplicate: true };
	if (soldEntries.length > 0) {
		const runtime = await loadRuntimeConfig(db);
		if (runtime.commerceSecret)
			await notifyWarehouseSale(
				db,
				delivery.order_item_id,
				soldEntries,
				runtime.commerceSecret,
			);
	}
	return {
		id: delivery.id,
		status: "delivered",
		orderStatus: nextStatus,
		duplicate: false,
	};
}

const deliverableOrderStatuses: readonly string[] = ["paid", "fulfilling"];
const closedOrderStatuses: readonly string[] = [
	"refunded",
	"cancelled",
	"expired",
];

async function closeUndeliverableDelivery(db: D1Database, deliveryId: string) {
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`UPDATE delivery_records SET status = 'failed', error_code = 'order_not_deliverable',
				 next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'processing')`,
			)
			.bind(now, deliveryId),
		db
			.prepare(
				`UPDATE outbox_events SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ?
				 WHERE event_type = 'delivery.requested' AND aggregate_type = 'delivery'
				 AND aggregate_id = ? AND status IN ('pending', 'processing')`,
			)
			.bind(now, now, deliveryId),
	]);
	return { id: deliveryId, status: "failed" as const, duplicate: false };
}

async function recordOwnedDeliveryFailure(
	db: D1Database,
	deliveryId: string,
	sku: string,
	stage: "conversion" | "finalization",
	error: unknown,
	stockId: string | null = null,
) {
	const code =
		error instanceof DomainError
			? error.code
			: `redeem_delivery_${stage}_failed`;
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"UPDATE delivery_records SET attempt_count=attempt_count+1,error_code=?,updated_at=? WHERE id=? AND status IN ('pending','processing')",
			)
			.bind(code, now, deliveryId),
		db
			.prepare(
				"INSERT INTO audit_logs (id,action,target_type,target_id,after,created_at) VALUES (?,'redeem_delivery.failure','delivery',?,?,?)",
			)
			.bind(
				crypto.randomUUID(),
				deliveryId,
				JSON.stringify({
					sku,
					stage,
					code,
					stockRef: stockId ? `gmstock-${stockId}` : null,
				}),
				now,
			),
	]);
}

type ManualDeliveryContext = Omit<DeliveryContext, "status"> & {
	status: "awaiting_supply" | "pending" | "processing" | "delivered" | "failed";
	fulfillment_source: string;
};

export async function startManualDelivery(db: D1Database, deliveryId: string) {
	const delivery = await db
		.prepare(
			`SELECT dr.id, dr.status, dr.delivery_type, dr.content_encrypted,
			 dr.order_item_id, item.fulfillment_source, dr.redeem_sku,
			 oi.order_id, oi.quantity, o.status AS order_status, o.version AS order_version
			 FROM delivery_records dr JOIN shop_order_items oi ON oi.id = dr.order_item_id
			 JOIN product_sellable_items item ON item.id = oi.sellable_item_id
			 JOIN shop_orders o ON o.id = oi.order_id WHERE dr.id = ? LIMIT 1`,
		)
		.bind(deliveryId)
		.first<ManualDeliveryContext>();
	if (!delivery)
		throw new DomainError("delivery_not_found", 404, "Delivery not found");
	if (
		delivery.delivery_type !== "stock" ||
		delivery.fulfillment_source !== "manual" ||
		delivery.redeem_sku !== null
	)
		throw new DomainError(
			"delivery_not_manual",
			409,
			"Delivery is not configured for manual fulfillment",
		);
	if (delivery.status === "processing")
		return {
			id: delivery.id,
			status: "processing" as const,
			orderStatus: delivery.order_status,
			duplicate: true,
		};
	if (delivery.status !== "awaiting_supply")
		throw new DomainError(
			"manual_delivery_not_awaiting_supply",
			409,
			"Manual delivery is not awaiting supply",
		);
	if (!["paid", "fulfilling"].includes(delivery.order_status))
		throw new DomainError(
			"manual_delivery_order_not_ready",
			409,
			"Order is not ready for manual processing",
		);
	const now = Date.now();
	const nextOrderStatus = "fulfilling";
	const nextVersion = delivery.order_version + 1;
	const results = await db.batch([
		db
			.prepare(
				`UPDATE delivery_records SET status = 'processing', updated_at = ?
				 WHERE id = ? AND status = 'awaiting_supply'`,
			)
			.bind(now, delivery.id),
		db
			.prepare(
				`UPDATE shop_orders SET status = ?, version = ?, updated_at = ?
				 WHERE id = ? AND status = ? AND version = ?`,
			)
			.bind(
				nextOrderStatus,
				nextVersion,
				now,
				delivery.order_id,
				delivery.order_status,
				delivery.order_version,
			),
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, from_status, to_status, order_version,
				  actor_type, created_at)
				 SELECT ?, id, 'fulfillment_started', 'customer', ?, ?, ?, 'admin', ?
				 FROM shop_orders WHERE id = ? AND status = ? AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				delivery.order_status,
				nextOrderStatus,
				nextVersion,
				now,
				delivery.order_id,
				nextOrderStatus,
				nextVersion,
			),
	]);
	if (
		Number(results[0]?.meta.changes ?? 0) !== 1 ||
		Number(results[1]?.meta.changes ?? 0) !== 1
	)
		throw new DomainError(
			"manual_delivery_start_conflict",
			409,
			"Manual delivery changed concurrently",
		);
	return {
		id: delivery.id,
		status: "processing" as const,
		orderStatus: nextOrderStatus,
		duplicate: false,
	};
}

export async function completeManualDelivery(
	db: D1Database,
	deliveryId: string,
	content: string,
) {
	const plaintext = content.trim();
	if (!plaintext || plaintext.length > 64_000)
		throw new DomainError(
			"manual_delivery_content_invalid",
			400,
			"Manual delivery content is required and must not exceed 64000 characters",
		);
	const delivery = await db
		.prepare(
			`SELECT dr.id, dr.status, dr.delivery_type, dr.content_encrypted,
			 dr.order_item_id, item.fulfillment_source, dr.redeem_sku,
			 oi.order_id, oi.quantity, o.status AS order_status, o.version AS order_version
			 FROM delivery_records dr JOIN shop_order_items oi ON oi.id = dr.order_item_id
			 JOIN product_sellable_items item ON item.id = oi.sellable_item_id
			 JOIN shop_orders o ON o.id = oi.order_id WHERE dr.id = ? LIMIT 1`,
		)
		.bind(deliveryId)
		.first<ManualDeliveryContext>();
	if (!delivery)
		throw new DomainError("delivery_not_found", 404, "Delivery not found");
	if (delivery.status === "delivered")
		return { id: delivery.id, status: "delivered", duplicate: true };
	if (
		delivery.delivery_type !== "stock" ||
		delivery.fulfillment_source !== "manual" ||
		delivery.redeem_sku !== null
	)
		throw new DomainError(
			"delivery_not_manual",
			409,
			"Delivery is not configured for manual fulfillment",
		);
	if (!["awaiting_supply", "processing"].includes(delivery.status))
		throw new DomainError(
			"manual_delivery_not_awaiting_supply",
			409,
			"Manual delivery is not awaiting supply or processing",
		);
	if (!deliverableOrderStatuses.includes(delivery.order_status))
		throw new DomainError(
			"manual_delivery_order_not_ready",
			409,
			"Order is not ready for manual processing",
		);
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"delivery_secret_unavailable",
			503,
			"Delivery configuration unavailable",
		);
	const encrypted = await encryptDeliveryContent(
		plaintext,
		runtime.commerceSecret,
	);
	const now = Date.now();
	const nextStatus = await nextOrderStatus(db, delivery.order_id, delivery.id);
	const nextVersion = delivery.order_version + 1;
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE delivery_records SET status = 'delivered', content_encrypted = ?,
				 content_key_version = 1, attempt_count = attempt_count + 1,
				 next_attempt_at = NULL, error_code = NULL, delivered_at = ?, updated_at = ?
				 WHERE id = ? AND status IN ('awaiting_supply', 'processing')`,
			)
			.bind(encrypted, now, now, delivery.id),
		db
			.prepare(
				`UPDATE shop_orders SET status = ?,
				 completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
				 version = ?, updated_at = ?
				 WHERE id = ? AND status = ? AND version = ?`,
			)
			.bind(
				nextStatus,
				nextStatus,
				now,
				nextVersion,
				now,
				delivery.order_id,
				delivery.order_status,
				delivery.order_version,
			),
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, from_status, to_status, order_version,
				  actor_type, created_at)
				 SELECT ?, id, 'delivery_progressed', 'customer', ?, ?, ?, 'admin', ?
				 FROM shop_orders WHERE id = ? AND status = ? AND version = ?`,
			)
			.bind(
				crypto.randomUUID(),
				delivery.order_status,
				nextStatus,
				nextVersion,
				now,
				delivery.order_id,
				nextStatus,
				nextVersion,
			),
		db
			.prepare(
				`INSERT INTO outbox_events
				 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
				  status, attempt_count, created_at, updated_at)
				 SELECT ?, 'delivery.ready', 'delivery', ?, ?, ?, 'pending', 0, ?, ?
				 FROM delivery_records WHERE id = ? AND status = 'delivered'
				 ON CONFLICT(idempotency_key) DO NOTHING`,
			)
			.bind(
				crypto.randomUUID(),
				delivery.id,
				`delivery-ready:${delivery.id}`,
				JSON.stringify({
					deliveryId: delivery.id,
					orderId: delivery.order_id,
				}),
				now,
				now,
				delivery.id,
			),
		...activateEntitlementGrantStatements(db, delivery.order_item_id, now),
	];
	const results = await db.batch(statements);
	if (Number(results[0]?.meta.changes ?? 0) < 1)
		return { id: delivery.id, status: "delivered", duplicate: true };
	return {
		id: delivery.id,
		status: "delivered",
		orderStatus: nextStatus,
		duplicate: false,
	};
}

export async function replaceDeliveredContent(
	db: D1Database,
	deliveryId: string,
	content: string,
) {
	const plaintext = content.trim();
	if (!plaintext || plaintext.length > 64_000)
		throw new DomainError(
			"delivery_content_invalid",
			400,
			"Delivery content is required and must not exceed 64000 characters",
		);
	const delivery = await db
		.prepare(
			`SELECT id, status, redeem_sku, content_encrypted
			 FROM delivery_records WHERE id = ? LIMIT 1`,
		)
		.bind(deliveryId)
		.first<{
			id: string;
			status: string;
			redeem_sku: string | null;
			content_encrypted: string | null;
		}>();
	if (!delivery)
		throw new DomainError("delivery_not_found", 404, "Delivery not found");
	if (delivery.status !== "delivered" || !delivery.content_encrypted)
		throw new DomainError(
			"delivery_content_not_replaceable",
			409,
			"Only delivered content can be replaced",
		);
	// Warehouse CDKs are tracked by the redeem warehouse; swap them there instead.
	if (delivery.redeem_sku !== null)
		throw new DomainError(
			"delivery_content_warehouse_managed",
			409,
			"Warehouse-managed delivery content cannot be replaced here",
		);
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"delivery_secret_unavailable",
			503,
			"Delivery configuration unavailable",
		);
	const previous = await decryptDeliveryContent(
		delivery.content_encrypted,
		runtime.commerceSecret,
	);
	if (previous === plaintext)
		return { id: delivery.id, status: "delivered" as const, changed: false };
	const encrypted = await encryptDeliveryContent(
		plaintext,
		runtime.commerceSecret,
	);
	const result = await db
		.prepare(
			`UPDATE delivery_records SET content_encrypted = ?, content_key_version = 1,
			 updated_at = ? WHERE id = ? AND status = 'delivered' AND content_encrypted = ?`,
		)
		.bind(encrypted, Date.now(), delivery.id, delivery.content_encrypted)
		.run();
	if (Number(result.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"delivery_content_replace_conflict",
			409,
			"Delivery content changed concurrently",
		);
	return { id: delivery.id, status: "delivered" as const, changed: true };
}

async function nextOrderStatus(
	db: D1Database,
	orderId: string,
	currentDeliveryId: string,
) {
	const remaining = await db
		.prepare(
			`SELECT COUNT(*) AS total FROM delivery_records dr
			 JOIN shop_order_items oi ON oi.id = dr.order_item_id
			 WHERE oi.order_id = ? AND dr.id <> ? AND dr.status <> 'delivered'`,
		)
		.bind(orderId, currentDeliveryId)
		.first<{ total: number }>();
	return Number(remaining?.total ?? 0) === 0 ? "completed" : "fulfilling";
}
