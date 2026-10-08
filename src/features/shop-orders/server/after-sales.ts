import type { z } from "zod";
import { canTransitionAfterSale } from "#/features/shop-orders/after-sale-status";
import {
	type AfterSaleStatus,
	afterSaleOpenSchema,
	afterSaleUpdateSchema,
} from "#/features/shop-orders/schema";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";

export async function openAfterSaleCase(
	db: D1Database,
	rawInput: z.input<typeof afterSaleOpenSchema>,
	context: {
		userId: string | null;
		actorUserId: string;
		request: Request;
	},
) {
	const input = afterSaleOpenSchema.parse(rawInput);
	const order = await db
		.prepare(`SELECT id, user_id, status FROM shop_orders WHERE id = ? LIMIT 1`)
		.bind(input.orderId)
		.first<{ id: string; user_id: string | null; status: string }>();
	if (!order) throw new DomainError("order_not_found", 404, "Order not found");
	if (context.userId && order.user_id !== context.userId)
		throw new DomainError("order_not_found", 404, "Order not found");
	if (["pending_payment", "cancelled", "expired"].includes(order.status))
		throw new DomainError(
			"after_sale_order_unavailable",
			409,
			"After-sale service is unavailable for this order",
		);
	if (context.userId && input.type !== "dispute") {
		const restricted = await db
			.prepare(
				`SELECT 1 FROM agent_access_orders a JOIN shop_order_items oi ON oi.id=a.order_item_id WHERE oi.order_id=? AND a.policy_snapshot IS NOT NULL LIMIT 1`,
			)
			.bind(order.id)
			.first();
		if (restricted)
			throw new DomainError(
				"agent_access_exception_support",
				409,
				"Access orders do not offer personal-reason refunds; use the exception support channel for activation failures, duplicate charges or other legally required remedies",
			);
	}
	if (input.orderItemId) {
		const item = await db
			.prepare(
				"SELECT id FROM shop_order_items WHERE id = ? AND order_id = ? LIMIT 1",
			)
			.bind(input.orderItemId, order.id)
			.first<{ id: string }>();
		if (!item)
			throw new DomainError(
				"order_item_not_found",
				404,
				"Order item not found",
			);
	}
	const existing = await db
		.prepare(
			`SELECT id FROM after_sale_cases WHERE order_id = ?
			 AND COALESCE(order_item_id, '') = COALESCE(?, '') AND type = ?
			 AND status IN ('open', 'processing') LIMIT 1`,
		)
		.bind(order.id, input.orderItemId, input.type)
		.first<{ id: string }>();
	if (existing)
		throw new DomainError(
			"after_sale_case_exists",
			409,
			"An active after-sale case already exists",
		);
	const id = crypto.randomUUID();
	const caseNumber = createCaseNumber();
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`INSERT INTO after_sale_cases
				 (id, order_id, order_item_id, case_number, type, status, reason,
				  opened_by_user_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
			)
			.bind(
				id,
				order.id,
				input.orderItemId,
				caseNumber,
				input.type,
				input.reason,
				context.userId,
				now,
				now,
			),
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, after_sale_case_id,
				  case_action, note, actor_type,
				  actor_user_id, created_at)
				 VALUES (?, ?, 'after_sale_opened', 'customer', ?, 'opened', ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				order.id,
				id,
				input.reason,
				context.userId ? "customer" : "admin",
				context.actorUserId,
				now,
			),
		caseOutboxStatement(db, id, "after_sale.opened", now),
		createAuditStatement(db, context.request, context.actorUserId, {
			action: "after_sale.opened",
			targetType: "after_sale_case",
			targetId: id,
			after: { orderId: order.id, caseNumber, type: input.type },
		}),
	]);
	return { id, caseNumber, status: "open" as const };
}

export async function updateAfterSaleCase(
	db: D1Database,
	rawInput: z.input<typeof afterSaleUpdateSchema>,
	context: { actorUserId: string; request: Request },
) {
	const input = afterSaleUpdateSchema.parse(rawInput);
	const current = await db
		.prepare(
			`SELECT id, order_id, status, resolution, assigned_user_id
			 FROM after_sale_cases WHERE id = ? LIMIT 1`,
		)
		.bind(input.id)
		.first<CaseRow>();
	if (!current)
		throw new DomainError(
			"after_sale_case_not_found",
			404,
			"After-sale case not found",
		);
	if (!canTransitionAfterSale(current.status, input.status))
		throw new DomainError(
			"after_sale_status_invalid",
			409,
			"After-sale status cannot be changed",
		);
	if (["resolved", "rejected"].includes(input.status) && !input.resolution)
		throw new DomainError(
			"after_sale_resolution_required",
			400,
			"A resolution is required",
		);
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`UPDATE after_sale_cases SET status = ?, resolution = ?,
				 assigned_user_id = COALESCE(assigned_user_id, ?),
				 resolved_at = CASE WHEN ? IN ('resolved', 'rejected', 'closed')
				  THEN ? ELSE resolved_at END, updated_at = ? WHERE id = ? AND status = ?`,
			)
			.bind(
				input.status,
				input.resolution || current.resolution,
				context.actorUserId,
				input.status,
				now,
				now,
				current.id,
				current.status,
			),
		db
			.prepare(
				`INSERT INTO shop_order_events
				 (id, order_id, event_type, visibility, after_sale_case_id,
				  case_action, note, actor_type,
				  actor_user_id, created_at)
				 VALUES (?, ?, 'after_sale_updated', 'customer', ?, ?, ?, 'admin', ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				current.order_id,
				current.id,
				`status:${input.status}`,
				input.note || input.resolution || null,
				context.actorUserId,
				now,
			),
		caseOutboxStatement(db, current.id, "after_sale.updated", now),
		createAuditStatement(db, context.request, context.actorUserId, {
			action: "after_sale.updated",
			targetType: "after_sale_case",
			targetId: current.id,
			before: { status: current.status, resolution: current.resolution },
			after: { status: input.status, resolution: input.resolution },
		}),
	]);
	return { id: current.id, status: input.status };
}

function caseOutboxStatement(
	db: D1Database,
	id: string,
	event: string,
	now: number,
) {
	return db
		.prepare(
			`INSERT INTO outbox_events
			 (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload,
			  status, attempt_count, created_at, updated_at)
			 VALUES (?, ?, 'after_sale_case', ?, ?, ?, 'pending', 0, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			event,
			id,
			`${event}:${id}:${now}`,
			JSON.stringify({ afterSaleCaseId: id }),
			now,
			now,
		);
}

function createCaseNumber() {
	const date = new Date();
	const day = [
		date.getUTCFullYear(),
		String(date.getUTCMonth() + 1).padStart(2, "0"),
		String(date.getUTCDate()).padStart(2, "0"),
	].join("");
	return `AS-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

type CaseRow = {
	id: string;
	order_id: string;
	status: AfterSaleStatus;
	resolution: string | null;
	assigned_user_id: string | null;
};
