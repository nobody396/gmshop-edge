import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireAdmin } from "#/features/access/server/require-admin";
import { systemPermission } from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";
import { getDb } from "#/server/db.server";
import { prepareAgentProducts } from "./products";

function privateResponse() {
	setResponseHeader("Cache-Control", "no-store");
}
function sameOrigin(request: Request) {
	if (request.headers.get("origin") !== new URL(request.url).origin)
		throw new DomainError("origin_invalid", 403, "Origin is not allowed");
}
export const prepareAgentProductsFn = createServerFn({
	method: "POST",
}).handler(async () => {
	const request = getRequest();
	sameOrigin(request);
	const actor = await requireAdmin(
		request,
		systemPermission("products", "update"),
	);
	const db = getDb(request).$client;
	const result = await prepareAgentProducts(db);
	await createAuditStatement(db, request, actor.id, {
		action: "agent_access.prepare_drafts",
		targetType: "product",
	}).run();
	return result;
});
export const retryAgentAccessFn = createServerFn({ method: "POST" })
	.validator((input: { orderItemId: string }) =>
		z.object({ orderItemId: z.uuid() }).parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		sameOrigin(request);
		const actor = await requireAdmin(
			request,
			systemPermission("delivery", "update"),
		);
		const db = getDb(request).$client;
		const result = await db.batch([
			db
				.prepare(
					`UPDATE agent_access_orders SET attempt_count=0,next_attempt_at=0,error_code=NULL,updated_at=? WHERE order_item_id=? AND state='pending' AND EXISTS(SELECT 1 FROM shop_order_items oi JOIN shop_orders o ON o.id=oi.order_id WHERE oi.id=agent_access_orders.order_item_id AND o.status IN ('paid','fulfilling'))`,
				)
				.bind(Date.now(), data.orderItemId),
			createAuditStatement(db, request, actor.id, {
				action: "agent_access.retry",
				targetType: "order_item",
				targetId: data.orderItemId,
			}),
		]);
		return { scheduled: (result[0]?.meta.changes ?? 0) > 0 };
	});

export const listAgentAccessIssuesFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const request = getRequest();
	privateResponse();
	await requireAdmin(request, systemPermission("delivery", "read"));
	const db = getDb(request).$client;
	return (
		await db
			.prepare(
				`SELECT a.order_item_id AS orderItemId,o.order_number AS orderNumber,a.kind,a.state,a.attempt_count AS attempts,a.error_code AS errorCode,o.status AS orderStatus FROM agent_access_orders a JOIN shop_order_items oi ON oi.id=a.order_item_id JOIN shop_orders o ON o.id=oi.order_id WHERE a.error_code IS NOT NULL AND a.state IN ('pending','active') ORDER BY a.updated_at DESC LIMIT 50`,
			)
			.all<{
				orderItemId: string;
				orderNumber: string;
				kind: string;
				state: string;
				attempts: number;
				errorCode: string;
				orderStatus: string;
			}>()
	).results;
});
