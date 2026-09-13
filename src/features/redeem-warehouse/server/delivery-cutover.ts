import { z } from "zod";
import { constantTimeEqual, sha256Hex } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { loadRuntimeConfig } from "#/server/runtime-config";
import { phRedeemSkuSchema } from "./convert-delivery";
import {
	loadDeliveryWarehouseToken,
	requestWarehouse,
} from "./warehouse-client";

const expectedNames = {
	GPT_PLUS_PH: "ChatGPT Plus 菲区 1个月",
	GPT_5X_PH: "ChatGPT Pro 5X 菲区 1个月",
	GPT_20X_PH: "ChatGPT Pro 20X 菲区 1个月",
} as const;
const inputSchema = z
	.object({
		componentId: z.uuid(),
		sku: phRedeemSkuSchema,
		enabled: z.boolean(),
		dryRun: z.boolean().default(false),
		trialOrderNumber: z
			.string()
			.regex(/^GM[A-F0-9]{32}$/)
			.optional(),
		requestRef: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/),
	})
	.strict();
function json(body: unknown, status = 200) {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
export async function handleRedeemCutover(
	request: Request,
	env: CloudflareBindings,
) {
	try {
		if (!env.RESTOCK_API_TOKEN || !env.DB)
			throw new DomainError("cutover_unavailable", 503, "Unavailable");
		const authorization = request.headers.get("authorization") || "";
		if (!constantTimeEqual(authorization, `Bearer ${env.RESTOCK_API_TOKEN}`))
			throw new DomainError("cutover_unauthorized", 401, "Unauthorized");
		const db = env.DB;
		if (request.method === "GET") {
			const componentId = z
				.uuid()
				.parse(new URL(request.url).searchParams.get("componentId"));
			const route = await db
				.prepare("SELECT value FROM system_settings WHERE key=?")
				.bind(`integration.redeem_delivery.${componentId}`)
				.first<{ value: string }>();
			const orders = await db
				.prepare(
					`SELECT d.redeem_sku,d.status,COUNT(*) AS count FROM delivery_records d JOIN shop_order_items i ON i.id=d.order_item_id WHERE i.delivery_component_id=? GROUP BY d.redeem_sku,d.status`,
				)
				.bind(componentId)
				.all();
			return json({
				ok: true,
				componentId,
				sku: route ? JSON.parse(route.value) : null,
				deliveries: orders.results,
			});
		}
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const text = await request.text();
		if (text.length > 4096)
			throw new DomainError("cutover_invalid", 400, "Invalid input");
		const data = inputSchema.parse(JSON.parse(text));
		if (data.dryRun && !data.enabled)
			throw new DomainError(
				"cutover_invalid",
				400,
				"Verification requires enabled target",
			);
		const trial = data.trialOrderNumber
			? await db
					.prepare("SELECT id,status FROM shop_orders WHERE order_number=?")
					.bind(data.trialOrderNumber)
					.first<{ id: string; status: string }>()
			: null;
		if (data.trialOrderNumber && !trial)
			throw new DomainError(
				"cutover_trial_not_found",
				404,
				"Trial order not found",
			);
		const routeKey = trial
			? `integration.redeem_delivery_trial.${trial.id}.${data.componentId}`
			: `integration.redeem_delivery.${data.componentId}`;
		const digest = await sha256Hex(
			JSON.stringify({
				componentId: data.componentId,
				sku: data.sku,
				enabled: data.enabled,
				trialOrderNumber: data.trialOrderNumber || null,
			}),
		);
		if (!data.dryRun) {
			const previous = await db
				.prepare(
					"SELECT payload_digest FROM replay_receipts WHERE namespace='redeem_delivery_cutover' AND scope_id=? AND external_id=?",
				)
				.bind(data.componentId, data.requestRef)
				.first<{ payload_digest: string }>();
			if (previous) {
				if (previous.payload_digest !== digest)
					throw new DomainError(
						"cutover_request_conflict",
						409,
						"Request reference reused",
					);
				const current = await db
					.prepare("SELECT value FROM system_settings WHERE key=?")
					.bind(routeKey)
					.first<{ value: string }>();
				return json({
					ok: true,
					componentId: data.componentId,
					sku: current ? JSON.parse(current.value) : null,
					idempotent: true,
					changed: false,
				});
			}
		}
		if (trial) {
			const shape = await db
				.prepare(
					"SELECT COUNT(*) AS count,SUM(CASE WHEN delivery_component_id=? AND quantity=1 THEN 1 ELSE 0 END) AS matched FROM shop_order_items WHERE order_id=?",
				)
				.bind(data.componentId, trial.id)
				.first<{ count: number; matched: number }>();
			if (
				trial.status !== "pending_payment" ||
				shape?.count !== 1 ||
				shape.matched !== 1
			)
				throw new DomainError(
					"cutover_trial_not_pending",
					409,
					"A single unpaid PH item is required",
				);
		}
		const item = await db
			.prepare(
				`SELECT item.name FROM product_sellable_items item JOIN products p ON p.id=item.product_id WHERE item.id=? AND item.enabled=1 AND p.status='active' AND p.product_type='stock' AND item.fulfillment_source IN ('local','supplier')`,
			)
			.bind(data.componentId)
			.first<{ name: string }>();
		if (item?.name !== expectedNames[data.sku])
			throw new DomainError(
				"cutover_sku_mismatch",
				409,
				"Exact PH item required",
			);
		if (data.enabled) {
			const runtime = await loadRuntimeConfig(db);
			if (!runtime.commerceSecret)
				throw new DomainError("cutover_unavailable", 503, "Unavailable");
			const token = await loadDeliveryWarehouseToken(
				db,
				runtime.commerceSecret,
			);
			const ready = z
				.object({
					success: z.literal(true),
					conversion_api_version: z.literal(1),
					data: z.array(z.object({ sku: z.string() })),
				})
				.parse(
					await requestWarehouse(token, "/api/internal/inventory/summary"),
				);
			if (!ready.data.some((row) => row.sku === data.sku))
				throw new DomainError(
					"cutover_warehouse_not_ready",
					409,
					"Warehouse not ready",
				);

			if (data.dryRun)
				return json({
					ok: true,
					componentId: data.componentId,
					sku: data.sku,
					configurationReady: true,
					changed: false,
				});
		}
		const key = routeKey,
			value = JSON.stringify(data.enabled ? data.sku : null),
			now = Date.now();
		// One D1 batch is the cutover boundary. It never edits existing orders, product visibility or stock.
		await db.batch([
			db
				.prepare(
					"SELECT CASE WHEN ? IS NULL OR (EXISTS (SELECT 1 FROM shop_orders WHERE id=? AND status='pending_payment') AND NOT EXISTS (SELECT 1 FROM delivery_records d JOIN shop_order_items i ON i.id=d.order_item_id WHERE i.order_id=?)) THEN 1 ELSE json_extract('cutover_trial_changed','$') END",
				)
				.bind(trial?.id || null, trial?.id || null, trial?.id || null),
			db
				.prepare(
					"INSERT INTO replay_receipts (id,namespace,scope_id,external_id,event_type,payload_digest,status,processed_at,created_at,updated_at) VALUES (?,'redeem_delivery_cutover',?,?,'route_changed',?,'processed',?,?,?)",
				)
				.bind(
					crypto.randomUUID(),
					data.componentId,
					data.requestRef,
					digest,
					now,
					now,
					now,
				),
			db
				.prepare(
					"INSERT INTO system_settings (key,value,is_secret,created_at,updated_at) VALUES (?,?,0,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
				)
				.bind(key, value, now, now),
			db
				.prepare(
					"INSERT INTO audit_logs (id,action,target_type,target_id,request_id,after,created_at) VALUES (?,'redeem_delivery.route_changed','sellable_item',?,?,?,?)",
				)
				.bind(
					crypto.randomUUID(),
					data.componentId,
					data.requestRef,
					JSON.stringify({
						sku: data.sku,
						enabled: data.enabled,
						trialOrderNumber: data.trialOrderNumber || null,
					}),
					now,
				),
		]);
		const readback = await db
			.prepare("SELECT value FROM system_settings WHERE key=?")
			.bind(key)
			.first<{ value: string }>();
		if (readback?.value !== value)
			throw new DomainError(
				"cutover_readback_conflict",
				409,
				"Routing changed concurrently",
			);
		return json({
			ok: true,
			componentId: data.componentId,
			sku: JSON.parse(value),
			existingOrdersUnchanged: true,
			trialOrderNumber: data.trialOrderNumber || null,
		});
	} catch (error) {
		if (error instanceof DomainError)
			return json({ ok: false, error: error.code }, error.status);
		if (error instanceof z.ZodError || error instanceof SyntaxError)
			return json({ ok: false, error: "cutover_invalid" }, 400);
		return json({ ok: false, error: "cutover_failed" }, 500);
	}
}
