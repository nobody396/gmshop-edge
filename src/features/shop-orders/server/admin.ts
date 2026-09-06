import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import {
	adminOrderListSchema,
	afterSaleOpenSchema,
	afterSaleUpdateSchema,
	manualRefundCompletionSchema,
	orderAdminNoteSchema,
	orderIdSchema,
	orderTransitionSchema,
	refundRequestSchema,
	type ShopOrderStatus,
} from "#/features/shop-orders/schema";
import {
	completeManualShopRefund,
	publishPendingRefunds,
	requestShopRefund,
	retryShopRefund,
} from "#/features/shop-payments/server/refunds";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";
import { getAdminServerContext } from "#/server/context";
import { getCloudflareEnv } from "#/server/db.server";
import { openAfterSaleCase, updateAfterSaleCase } from "./after-sales";
import { transitionShopOrder } from "./transition";

type OrderRow = {
	id: string;
	order_number: string;
	user_id: string | null;
	contact_email: string | null;
	status: ShopOrderStatus;
	currency: string;
	currency_decimals: number;
	subtotal_minor: string;
	discount_minor: string;
	total_minor: string;
	paid_minor: string;
	customer_note: string | null;
	admin_note: string | null;
	version: number;
	expires_at: number;
	paid_at: number | null;
	completed_at: number | null;
	cancelled_at: number | null;
	refunded_at: number | null;
	created_at: number;
	updated_at: number;
	user_name: string | null;
	item_count: number;
	delivery_pending_count: number;
	delivery_failed_count: number;
	source: "storefront" | "supplier_api";
};

export const listShopOrdersFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof adminOrderListSchema>) =>
		adminOrderListSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await getAdminServerContext(
			systemPermission("orders", "read"),
		);
		const search = data.search ? `%${data.search}%` : null;
		const where = search
			? "WHERE o.order_number LIKE ? OR o.contact_email LIKE ? OR u.name LIKE ?"
			: "";
		const bindings = search ? [search, search, search] : [];
		const [count, rows] = await db.$client.batch([
			db.$client
				.prepare(
					`SELECT COUNT(*) AS total FROM shop_orders o
					 LEFT JOIN users u ON u.id = o.user_id ${where}`,
				)
				.bind(...bindings),
			db.$client
				.prepare(
					`SELECT o.*, u.name AS user_name,
					 CASE WHEN EXISTS (SELECT 1 FROM supplier_api_orders api
					  WHERE api.shop_order_id = o.id) THEN 'supplier_api' ELSE 'storefront' END AS source,
					 (SELECT COUNT(*) FROM shop_order_items oi WHERE oi.order_id = o.id) AS item_count,
					 (SELECT COUNT(*) FROM delivery_records dr INNER JOIN shop_order_items oi
					  ON oi.id = dr.order_item_id WHERE oi.order_id = o.id
					  AND dr.status IN ('pending', 'processing')) AS delivery_pending_count,
					 (SELECT COUNT(*) FROM delivery_records dr INNER JOIN shop_order_items oi
					  ON oi.id = dr.order_item_id WHERE oi.order_id = o.id
					  AND dr.status = 'failed') AS delivery_failed_count
					 FROM shop_orders o LEFT JOIN users u ON u.id = o.user_id
					 ${where} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`,
				)
				.bind(...bindings, data.pageSize, data.pageIndex * data.pageSize),
		]);
		return {
			data: ((rows?.results ?? []) as OrderRow[]).map(presentOrder),
			total: Number(
				(count?.results[0] as { total?: unknown } | undefined)?.total ?? 0,
			),
		};
	});

export const getShopOrderFn = createServerFn({ method: "GET" })
	.validator((input: z.input<typeof orderIdSchema>) =>
		orderIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db } = await getAdminServerContext(
			systemPermission("orders", "read"),
		);
		const order = await db.$client
			.prepare(
				`SELECT o.*, u.name AS user_name,
				 CASE WHEN EXISTS (SELECT 1 FROM supplier_api_orders api
				  WHERE api.shop_order_id = o.id) THEN 'supplier_api' ELSE 'storefront' END AS source,
				 (SELECT COUNT(*) FROM shop_order_items oi WHERE oi.order_id = o.id) AS item_count,
				 (SELECT COUNT(*) FROM delivery_records dr INNER JOIN shop_order_items oi
				  ON oi.id = dr.order_item_id WHERE oi.order_id = o.id
				  AND dr.status IN ('pending', 'processing')) AS delivery_pending_count,
				 (SELECT COUNT(*) FROM delivery_records dr INNER JOIN shop_order_items oi
				  ON oi.id = dr.order_item_id WHERE oi.order_id = o.id
				  AND dr.status = 'failed') AS delivery_failed_count
				 FROM shop_orders o LEFT JOIN users u ON u.id = o.user_id
				 WHERE o.id = ? LIMIT 1`,
			)
			.bind(data.id)
			.first<OrderRow>();
		if (!order)
			throw new DomainError("order_not_found", 404, "Order not found");
		const [items, payments, deliveries, events, refunds, afterSales] =
			await db.$client.batch([
				db.$client
					.prepare(
						`SELECT item.*, entitlement.status AS entitlement_status,
						 entitlement.activated_at, entitlement.expires_at,
						 entitlement.usage_limit AS current_usage_limit,
						 entitlement.usage_count, entitlement.access_limit AS current_access_limit,
						 entitlement.access_count
						 FROM shop_order_items item
						 LEFT JOIN entitlement_grants grant_row ON grant_row.source_order_item_id = item.id
						 LEFT JOIN customer_entitlements entitlement ON entitlement.id = grant_row.entitlement_id
						 WHERE item.order_id = ? ORDER BY item.created_at, item.id`,
					)
					.bind(data.id),
				db.$client
					.prepare(
						`SELECT pa.*, pc.name AS channel_name, pc.provider
						 FROM payment_attempts pa INNER JOIN payment_channels pc ON pc.id = pa.channel_id
						 WHERE pa.order_id = ? ORDER BY pa.created_at DESC, pa.id DESC`,
					)
					.bind(data.id),
				db.$client
					.prepare(
						`SELECT dr.*, oi.product_name, oi.sellable_item_name FROM delivery_records dr
						 INNER JOIN shop_order_items oi ON oi.id = dr.order_item_id
						 WHERE oi.order_id = ? ORDER BY dr.created_at, dr.id`,
					)
					.bind(data.id),
				db.$client
					.prepare(
						"SELECT * FROM shop_order_events WHERE order_id = ? ORDER BY created_at DESC, id DESC",
					)
					.bind(data.id),
				db.$client
					.prepare(
						"SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at DESC, id DESC",
					)
					.bind(data.id),
				db.$client
					.prepare(
						"SELECT * FROM after_sale_cases WHERE order_id = ? ORDER BY created_at DESC, id DESC",
					)
					.bind(data.id),
			]);
		return {
			...presentOrder(order),
			items: resultRows(items).map(presentOrderItem),
			payments: resultRows(payments).map(presentPayment),
			deliveries: resultRows(deliveries).map(presentDelivery),
			events: resultRows(events).map(presentEvent),
			refunds: resultRows(refunds).map(presentRefund),
			afterSales: resultRows(afterSales).map(presentAfterSale),
		};
	});

function resultRows(result: D1Result<unknown> | undefined) {
	return (result?.results ?? []) as Record<string, unknown>[];
}

export const transitionShopOrderFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof orderTransitionSchema>) =>
		orderTransitionSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("orders", "update"),
		);
		const result = await transitionShopOrder(db.$client, {
			...data,
			actorType: "admin",
			actorUserId: currentUser.id,
			request,
		});
		return result;
	});

export const saveShopOrderAdminNoteFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof orderAdminNoteSchema>) =>
		orderAdminNoteSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("orders", "update"),
		);
		const before = await db.$client
			.prepare("SELECT id, admin_note FROM shop_orders WHERE id = ? LIMIT 1")
			.bind(data.id)
			.first<Record<string, unknown>>();
		if (!before)
			throw new DomainError("order_not_found", 404, "Order not found");
		const now = Date.now();
		await db.$client.batch([
			db.$client
				.prepare(
					"UPDATE shop_orders SET admin_note = ?, updated_at = ? WHERE id = ?",
				)
				.bind(data.note, now, data.id),
			db.$client
				.prepare(
					`INSERT INTO shop_order_events
					 (id, order_id, event_type, visibility, note, actor_type, actor_user_id, created_at)
					 VALUES (?, ?, 'admin_note', 'internal', ?, 'admin', ?, ?)`,
				)
				.bind(crypto.randomUUID(), data.id, data.note, currentUser.id, now),
			createAuditStatement(db.$client, request, currentUser.id, {
				action: "shop_order.note_updated",
				targetType: "shop_order",
				targetId: data.id,
				before,
				after: { note: data.note },
			}),
		]);
		return { id: data.id };
	});

export const requestShopRefundFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof refundRequestSchema>) =>
		refundRequestSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("orders", "update"),
		);
		const refund = await requestShopRefund(db.$client, data, {
			actorUserId: currentUser.id,
			request,
		});
		const queue = getCloudflareEnv(request).COMMERCE_QUEUE;
		if (queue) await publishPendingRefunds(db.$client, queue);
		return refund;
	});

export const retryShopRefundFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof orderIdSchema>) =>
		orderIdSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("orders", "update"),
		);
		const refund = await retryShopRefund(db.$client, data.id, {
			actorUserId: currentUser.id,
			request,
		});
		const queue = getCloudflareEnv(request).COMMERCE_QUEUE;
		if (queue) await publishPendingRefunds(db.$client, queue);
		return refund;
	});

export const completeManualShopRefundFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof manualRefundCompletionSchema>) =>
		manualRefundCompletionSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("orders", "update"),
		);
		return completeManualShopRefund(
			db.$client,
			data.id,
			data.reference,
			data.fundsReturned,
			{
				actorUserId: currentUser.id,
				request,
			},
		);
	});

export const openAfterSaleCaseFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof afterSaleOpenSchema>) =>
		afterSaleOpenSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("orders", "update"),
		);
		return openAfterSaleCase(db.$client, data, {
			userId: null,
			actorUserId: currentUser.id,
			request,
		});
	});

export const updateAfterSaleCaseFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof afterSaleUpdateSchema>) =>
		afterSaleUpdateSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { currentUser, db, request } = await getAdminServerContext(
			systemPermission("orders", "update"),
		);
		return updateAfterSaleCase(db.$client, data, {
			actorUserId: currentUser.id,
			request,
		});
	});

function presentOrder(row: OrderRow) {
	return {
		id: row.id,
		orderNumber: row.order_number,
		source: row.source,
		userId: row.user_id,
		userName: row.user_name,
		contactEmail: row.contact_email,
		status: row.status,
		currency: row.currency,
		currencyDecimals: row.currency_decimals,
		subtotalMinor: row.subtotal_minor,
		discountMinor: row.discount_minor,
		totalMinor: row.total_minor,
		paidMinor: row.paid_minor,
		customerNote: row.customer_note,
		adminNote: row.admin_note,
		version: row.version,
		expiresAt: row.expires_at,
		paidAt: row.paid_at,
		completedAt: row.completed_at,
		cancelledAt: row.cancelled_at,
		refundedAt: row.refunded_at,
		itemCount: Number(row.item_count),
		deliveryPendingCount: Number(row.delivery_pending_count),
		deliveryFailedCount: Number(row.delivery_failed_count),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function presentOrderItem(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		productId: String(row.product_id),
		productName: String(row.product_name),
		deliveryComponentId: String(row.delivery_component_id),
		deliveryType: String(row.delivery_component_type),
		deliveryComponentVersion: Number(row.delivery_component_version),
		sellableItemName: String(row.sellable_item_name),
		quantity: Number(row.quantity),
		unitPriceMinor: String(row.unit_price_minor),
		unitCostMinor:
			row.unit_cost_minor == null ? null : String(row.unit_cost_minor),
		discountMinor: String(row.discount_minor),
		subtotalMinor: String(row.subtotal_minor),
		durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
		usageLimit: row.usage_limit == null ? null : Number(row.usage_limit),
		accessLimit: row.access_limit == null ? null : Number(row.access_limit),
		renewalMode: String(row.renewal_mode),
		emailMode: String(row.email_mode),
		entitlementStatus:
			row.entitlement_status == null ? null : String(row.entitlement_status),
		activatedAt: row.activated_at == null ? null : Number(row.activated_at),
		expiresAt: row.expires_at == null ? null : Number(row.expires_at),
		currentUsageLimit:
			row.current_usage_limit == null ? null : Number(row.current_usage_limit),
		usageCount: row.usage_count == null ? 0 : Number(row.usage_count),
		currentAccessLimit:
			row.current_access_limit == null
				? null
				: Number(row.current_access_limit),
		accessCount: row.access_count == null ? 0 : Number(row.access_count),
	};
}

function presentPayment(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		channelName: String(row.channel_name),
		provider: String(row.provider),
		status: String(row.status),
		amountMinor: String(row.amount_minor),
		currency: String(row.currency),
		currencyDecimals: Number(row.currency_decimals),
		exchangeRate: String(row.exchange_rate),
		exchangeRateDirection: String(row.exchange_rate_direction),
		exchangeRateSource: String(row.exchange_rate_source),
		exchangeRateObservedAt: Number(row.exchange_rate_observed_at),
		checkoutUrl: row.checkout_url ? String(row.checkout_url) : null,
		failureCode: row.failure_code ? String(row.failure_code) : null,
		createdAt: Number(row.created_at),
	};
}

function presentDelivery(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		productName: String(row.product_name),
		sellableItemName: String(row.sellable_item_name),
		type: String(row.delivery_type),
		status: String(row.status),
		attemptCount: Number(row.attempt_count),
		errorCode: row.error_code ? String(row.error_code) : null,
		deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at),
		createdAt: Number(row.created_at),
	};
}

function presentEvent(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		type: String(row.event_type),
		visibility: String(row.visibility),
		fromStatus: row.from_status ? String(row.from_status) : null,
		toStatus: row.to_status ? String(row.to_status) : null,
		version: row.order_version == null ? null : Number(row.order_version),
		note: row.note ? String(row.note) : null,
		actorType: String(row.actor_type),
		createdAt: Number(row.created_at),
	};
}

function presentRefund(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		status: String(row.status),
		amountMinor: String(row.amount_minor),
		currency: String(row.currency),
		paymentAmountMinor: String(row.payment_amount_minor),
		paymentCurrency: String(row.payment_currency),
		paymentCurrencyDecimals: Number(row.payment_currency_decimals),
		reason: String(row.reason),
		failureCode: row.failure_code ? String(row.failure_code) : null,
		attemptCount: Number(row.attempt_count),
		nextAttemptAt:
			row.next_attempt_at == null ? null : Number(row.next_attempt_at),
		completedAt: row.completed_at == null ? null : Number(row.completed_at),
		createdAt: Number(row.created_at),
	};
}

function presentAfterSale(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		caseNumber: String(row.case_number),
		type: String(row.type),
		status: String(row.status),
		reason: String(row.reason),
		resolution: row.resolution ? String(row.resolution) : null,
		orderItemId: row.order_item_id ? String(row.order_item_id) : null,
		assignedUserId: row.assigned_user_id ? String(row.assigned_user_id) : null,
		updatedAt: Number(row.updated_at),
		createdAt: Number(row.created_at),
	};
}
