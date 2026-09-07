import { z } from "zod";
import { inventoryImportSchema } from "#/features/catalog/schema";
import { constantTimeEqual, sha256Hex } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
import { encryptSecret } from "#/lib/secrets";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { loadRuntimeConfig } from "#/server/runtime-config";
import {
	fingerprintInventorySecret,
	formatInventoryDelivery,
	maskInventorySecret,
	normalizeInventorySecrets,
} from "./inventory-secrets";

const MAX_BATCH_SIZE = 90;

const restockRequestSchema = z.object({
	requestRef: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9_-]{16,100}$/),
	componentId: z.uuid(),
	secrets: z
		.array(z.string().trim().min(1).max(2_000))
		.min(1)
		.max(MAX_BATCH_SIZE),
	usageUrl: z.string().optional(),
	note: z.string().trim().max(500).optional(),
	source: z.string().trim().min(1).max(100),
});

type RestockRequest = z.infer<typeof restockRequestSchema>;

type ComponentRow = {
	id: string;
	product_name: string;
	item_name: string;
	supplier_bound: number;
};

export async function handleRestockApiRequest(
	request: Request,
	env: CloudflareBindings,
): Promise<Response> {
	try {
		const db = env.DB;
		if (!db || !env.RESTOCK_API_TOKEN)
			throw new DomainError(
				"restock_api_unavailable",
				503,
				"Restock API unavailable",
			);
		requireAuthorization(request, env.RESTOCK_API_TOKEN);
		const ipAddress = request.headers.get("cf-connecting-ip") ?? "unknown";
		const budget = await claimFixedWindowRateLimit(db, {
			bucketKey: `restock-api:${ipAddress}`,
			limit: 20,
			windowMs: 60_000,
			now: Date.now(),
		});
		if (!budget.allowed)
			throw new DomainError("restock_rate_limited", 429, "Rate limit exceeded");

		if (request.method === "GET") return stockSnapshot(request, db);
		if (request.method !== "POST")
			return new Response(null, {
				status: 405,
				headers: { Allow: "GET, POST" },
			});

		const contentLength = Number(request.headers.get("content-length") ?? "0");
		if (contentLength > 250_000)
			throw new DomainError(
				"restock_payload_too_large",
				413,
				"Payload too large",
			);
		const data = restockRequestSchema.parse(await request.json());
		return json(await importRestockBatch(db, request, data), 200);
	} catch (error) {
		if (error instanceof DomainError)
			return json({ ok: false, error: error.code }, error.status);
		if (error instanceof z.ZodError)
			return json({ ok: false, error: "restock_invalid" }, 400);
		if (error instanceof SyntaxError)
			return json({ ok: false, error: "restock_invalid" }, 400);
		return json({ ok: false, error: "restock_failed" }, 500);
	}
}

async function importRestockBatch(
	db: D1Database,
	request: Request,
	data: RestockRequest,
) {
	const inventory = inventoryImportSchema.parse({
		componentId: data.componentId,
		content: data.secrets.join("\n"),
		note: data.note,
		usageUrl: data.usageUrl ?? "",
	});
	const normalized = normalizeInventorySecrets(inventory.content);
	if (normalized.length !== data.secrets.length)
		throw new DomainError(
			"restock_duplicate_input",
			400,
			"Duplicate inventory entries are not accepted",
		);
	const component = await loadComponent(db, inventory.componentId);
	const runtime = await loadRuntimeConfig(db);
	if (!runtime.commerceSecret)
		throw new DomainError(
			"inventory_secret_unavailable",
			503,
			"Inventory encryption secret is unavailable",
		);
	const commerceSecret = runtime.commerceSecret;

	const payloadDigest = await sha256Hex(
		JSON.stringify({
			componentId: inventory.componentId,
			secrets: normalized,
			usageUrl: inventory.usageUrl,
			source: data.source,
		}),
	);
	const existing = await db
		.prepare(
			`SELECT payload_digest, status FROM replay_receipts
			 WHERE namespace = 'restock_api' AND scope_id = ? AND external_id = ? LIMIT 1`,
		)
		.bind(inventory.componentId, data.requestRef)
		.first<{ payload_digest: string; status: string }>();
	if (existing) {
		if (existing.payload_digest !== payloadDigest)
			throw new DomainError(
				"restock_request_conflict",
				409,
				"Request reference already belongs to another payload",
			);
		const counts = await inventoryCounts(db, inventory.componentId);
		return {
			ok: true,
			idempotent: true,
			requestRef: data.requestRef,
			component: publicComponent(component),
			imported: 0,
			duplicates: 0,
			counts,
		};
	}

	const prepared = await Promise.all(
		normalized.map(async (secret) => ({
			id: crypto.randomUUID(),
			fingerprint: await fingerprintInventorySecret(secret, commerceSecret),
			mask: maskInventorySecret(secret),
			encrypted: await encryptSecret(
				formatInventoryDelivery(
					secret,
					inventory.usageUrl,
					Boolean(component.supplier_bound),
				),
				commerceSecret,
				"stock-entry",
			),
		})),
	);
	const duplicate = await db
		.prepare(
			`SELECT 1 FROM stock_entries WHERE sellable_item_id = ?
			 AND content_fingerprint IN (${prepared.map(() => "?").join(", ")}) LIMIT 1`,
		)
		.bind(inventory.componentId, ...prepared.map((item) => item.fingerprint))
		.first();
	if (duplicate)
		throw new DomainError(
			"restock_duplicate_inventory",
			409,
			"Inventory entry already exists",
		);
	const now = Date.now();
	const note = [
		data.note,
		`source=${data.source}`,
		`request_ref=${data.requestRef}`,
	]
		.filter(Boolean)
		.join("; ");
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO replay_receipts
				 (id, namespace, scope_id, external_id, event_type, payload_digest,
				  status, processed_at, created_at, updated_at)
				 VALUES (?, 'restock_api', ?, ?, 'inventory_import', ?, 'processed', ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				inventory.componentId,
				data.requestRef,
				payloadDigest,
				now,
				now,
				now,
			),
		...prepared.map((item) =>
			db
				.prepare(
					`INSERT OR IGNORE INTO stock_entries
					 (id, sellable_item_id, content_encrypted, key_version,
					  content_fingerprint, content_mask, status, note, created_at, updated_at)
					 VALUES (?, ?, ?, 1, ?, ?, 'available', ?, ?, ?)`,
				)
				.bind(
					item.id,
					inventory.componentId,
					item.encrypted,
					item.fingerprint,
					item.mask,
					note,
					now,
					now,
				),
		),
		db
			.prepare(
				`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id,
				  ip_address, before, after, created_at)
				 VALUES (?, NULL, 'inventory.restock_api_imported', 'delivery_component',
				  ?, ?, ?, NULL, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				inventory.componentId,
				request.headers.get("x-request-id") ?? data.requestRef,
				request.headers.get("cf-connecting-ip"),
				JSON.stringify({
					requestRef: data.requestRef,
					source: data.source,
					requested: prepared.length,
				}),
				now,
			),
	]);
	const stockResults = results.slice(1, 1 + prepared.length);
	const imported = stockResults.reduce(
		(total, result) => total + Number(result.meta.changes ?? 0),
		0,
	);
	const counts = await inventoryCounts(db, inventory.componentId);
	return {
		ok: true,
		idempotent: false,
		requestRef: data.requestRef,
		component: publicComponent(component),
		imported,
		duplicates: prepared.length - imported,
		counts,
	};
}

async function stockSnapshot(request: Request, db: D1Database) {
	const componentId =
		new URL(request.url).searchParams.get("componentId") ?? "";
	const parsed = z.uuid().safeParse(componentId);
	if (!parsed.success)
		throw new DomainError("restock_invalid", 400, "Invalid component id");
	const component = await loadComponent(db, parsed.data);
	return json(
		{
			ok: true,
			component: publicComponent(component),
			counts: await inventoryCounts(db, parsed.data),
		},
		200,
	);
}

async function loadComponent(db: D1Database, componentId: string) {
	const component = await db
		.prepare(
			`SELECT item.id, product.name AS product_name, item.name AS item_name,
			 EXISTS (SELECT 1 FROM supplier_bindings binding
			  WHERE binding.sellable_item_id = item.id AND binding.enabled = 1) AS supplier_bound
			 FROM product_sellable_items item JOIN products product ON product.id = item.product_id
			 WHERE item.id = ? AND product.product_type = 'stock' AND item.enabled = 1
			  AND (item.fulfillment_source = 'local' OR EXISTS (
			   SELECT 1 FROM supplier_bindings binding
			   WHERE binding.sellable_item_id = item.id AND binding.enabled = 1)) LIMIT 1`,
		)
		.bind(componentId)
		.first<ComponentRow>();
	if (!component)
		throw new DomainError(
			"stock_component_not_found",
			404,
			"Stock delivery component not found",
		);
	return component;
}

async function inventoryCounts(db: D1Database, componentId: string) {
	const row = await db
		.prepare(
			`SELECT
			 SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available,
			 SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END) AS reserved,
			 SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
			 SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled
			 FROM stock_entries WHERE sellable_item_id = ?`,
		)
		.bind(componentId)
		.first<Record<string, number | null>>();
	return {
		available: Number(row?.available ?? 0),
		reserved: Number(row?.reserved ?? 0),
		delivered: Number(row?.delivered ?? 0),
		disabled: Number(row?.disabled ?? 0),
	};
}

function requireAuthorization(request: Request, expected: string) {
	const header = request.headers.get("authorization") ?? "";
	const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (!supplied || !constantTimeEqual(supplied, expected))
		throw new DomainError("restock_unauthorized", 401, "Invalid credentials");
}

function publicComponent(component: ComponentRow) {
	return {
		id: component.id,
		productName: component.product_name,
		itemName: component.item_name,
		supplierBound: Boolean(component.supplier_bound),
	};
}

function json(payload: unknown, status: number) {
	return Response.json(payload, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
