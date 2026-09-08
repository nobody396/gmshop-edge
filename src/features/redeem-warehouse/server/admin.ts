import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import {
	fingerprintInventorySecret,
	formatInventoryDelivery,
	maskInventorySecret,
} from "#/features/catalog/server/inventory-secrets";
import { sha256Hex } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { decimalToMinor } from "#/lib/units";
import { getAdminRuntimeServerContext } from "#/server/context";

const tokenKey = "integration.redeem_warehouse_token";
const tokenPurpose = "redeem-warehouse-token";
const warehouseBaseUrl = "https://redeem.laoshirenvip.com";

const configurationSchema = z.object({
	token: z.string().trim().min(32).max(500).optional(),
});

const importSchema = z.object({
	sku: z.string().trim().min(1).max(100),
	unitCostYuan: z
		.string()
		.trim()
		.regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/)
		.optional(),
	content: z.string().trim().min(1).max(250_000),
});

const generateSellableSchema = z.object({
	requestRef: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9_-]{16,100}$/),
	sku: z.string().trim().min(1).max(100),
	componentId: z.uuid(),
	count: z.number().int().min(1).max(100),
});

const inventoryRowSchema = z.object({
	sku: z.string(),
	display_name: z.string(),
	family: z.enum(["gpt", "claude"]),
	input_kind: z.enum(["gpt_session", "claude_session_key"]),
	available: z.number().int().nonnegative(),
	leased: z.number().int().nonnegative(),
	processing: z.number().int().nonnegative(),
	consumed: z.number().int().nonnegative(),
	quarantined: z.number().int().nonnegative(),
});

const inventoryEnvelopeSchema = z.object({
	success: z.literal(true),
	data: z.array(inventoryRowSchema).length(7),
});

const importEnvelopeSchema = z.object({
	success: z.literal(true),
	data: z.object({
		imported: z.number().int().nonnegative(),
		total: z.number().int().positive(),
		results: z.array(
			z.object({
				index: z.number().int().nonnegative(),
				status: z.string(),
				reason: z.string().optional(),
			}),
		),
	}),
});

const batchIssueEnvelopeSchema = z.object({
	success: z.literal(true),
	data: z.object({
		sku: z.string(),
		count: z.number().int().positive(),
		codes: z.array(z.string().min(20).max(200)).min(1).max(100),
	}),
});

export const getRedeemWarehouseConfigurationFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const context = await getAdminRuntimeServerContext(
		systemPermission("settings", "read"),
	);
	const rows = await loadSettingRows(context.db);
	return {
		configured: Boolean(rows.get(tokenKey)),
	};
});

export const saveRedeemWarehouseConfigurationFn = createServerFn({
	method: "POST",
})
	.validator((input: z.input<typeof configurationSchema>) =>
		configurationSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("settings", "update"),
		);
		if (!context.runtime.commerceSecret) throw unavailable();
		const rows = await loadSettingRows(context.db);
		const existingToken = rows.get(tokenKey)
			? await decryptSecret(
					settingString(rows.get(tokenKey)),
					context.runtime.commerceSecret,
					tokenPurpose,
				)
			: "";
		const token = data.token || existingToken;
		if (!token)
			throw new DomainError(
				"redeem_warehouse_token_required",
				400,
				"Token required",
			);
		await requestWarehouse(token, "/api/internal/inventory/summary");
		const now = Date.now();
		const encryptedToken = data.token
			? await encryptSecret(
					data.token,
					context.runtime.commerceSecret,
					tokenPurpose,
				)
			: settingString(rows.get(tokenKey));
		await context.db.batch([
			upsertSetting(
				context.db,
				tokenKey,
				encryptedToken,
				true,
				context.currentUser.id,
				now,
			),
			context.db
				.prepare(
					`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
				 VALUES (?, ?, 'redeem_warehouse.configuration_saved', 'system_setting', ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					context.currentUser.id,
					tokenKey,
					context.request.headers.get("x-request-id"),
					context.request.headers.get("cf-connecting-ip"),
					JSON.stringify({ tokenUpdated: Boolean(data.token) }),
					now,
				),
		]);
		return { configured: true };
	});

export const listRedeemWarehouseInventoryFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const context = await getAdminRuntimeServerContext(
		systemPermission("inventory", "read"),
	);
	const config = await loadWarehouseConfig(context);
	const result = inventoryEnvelopeSchema.parse(
		await requestWarehouse(config.token, "/api/internal/inventory/summary"),
	);
	return result.data.map((row) => ({
		sku: row.sku,
		displayName: row.display_name,
		family: row.family,
		inputKind: row.input_kind,
		available: row.available,
		leased: row.leased,
		processing: row.processing,
		consumed: row.consumed,
		quarantined: row.quarantined,
	}));
});

export const importRedeemWarehouseInventoryFn = createServerFn({
	method: "POST",
})
	.validator((input: z.input<typeof importSchema>) => importSchema.parse(input))
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("inventory", "create"),
		);
		const config = await loadWarehouseConfig(context);
		const keys = data.content
			.split(/\r?\n/)
			.map((value) => value.trim())
			.filter(Boolean);
		if (keys.length > 100)
			throw new DomainError(
				"redeem_warehouse_batch_too_large",
				400,
				"Import at most 100 keys",
			);
		const unitCostMinor = data.unitCostYuan
			? decimalToMinor(data.unitCostYuan, 2).toString()
			: undefined;
		const result = importEnvelopeSchema.parse(
			await requestWarehouse(config.token, "/api/internal/inventory/import", {
				method: "POST",
				body: JSON.stringify({
					sku: data.sku,
					keys,
					...(unitCostMinor ? { unit_cost_minor: unitCostMinor } : {}),
				}),
			}),
		);
		const counts = result.data.results.reduce<Record<string, number>>(
			(summary, item) => {
				summary[item.status] = (summary[item.status] ?? 0) + 1;
				return summary;
			},
			{},
		);
		await context.db
			.prepare(
				`INSERT INTO audit_logs
			 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
			 VALUES (?, ?, 'redeem_warehouse.inventory_imported', 'redeem_sku', ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				context.currentUser.id,
				data.sku,
				context.request.headers.get("x-request-id"),
				context.request.headers.get("cf-connecting-ip"),
				JSON.stringify({
					total: result.data.total,
					imported: result.data.imported,
					counts,
					unitCostMinor: unitCostMinor ?? null,
				}),
				Date.now(),
			)
			.run();
		return { total: result.data.total, imported: result.data.imported, counts };
	});

export const generateRedeemSellableInventoryFn = createServerFn({
	method: "POST",
})
	.validator((input: z.input<typeof generateSellableSchema>) =>
		generateSellableSchema.parse(input),
	)
	.handler(async ({ data }) =>
		generateRedeemSellableInventory(
			data,
			await getAdminRuntimeServerContext(
				systemPermission("inventory", "create"),
			),
		),
	);

export async function generateRedeemSellableInventory(
	data: z.infer<typeof generateSellableSchema>,
	context: Awaited<ReturnType<typeof getAdminRuntimeServerContext>>,
	requester: typeof requestWarehouse = requestWarehouse,
) {
	if (!context.runtime.commerceSecret) throw unavailable();
	const component = await context.db
		.prepare(
			`SELECT item.id FROM product_sellable_items item JOIN products product ON product.id = item.product_id
			 WHERE item.id = ? AND item.enabled = 1 AND item.fulfillment_source = 'local'
			  AND product.status = 'active' AND product.product_type = 'stock' LIMIT 1`,
		)
		.bind(data.componentId)
		.first<{ id: string }>();
	if (!component)
		throw new DomainError(
			"redeem_sellable_component_not_found",
			404,
			"Stock item not found",
		);
	const payloadDigest = await sha256Hex(
		JSON.stringify({
			sku: data.sku,
			componentId: data.componentId,
			count: data.count,
		}),
	);
	const existing = await context.db
		.prepare(
			`SELECT payload_digest FROM replay_receipts
			 WHERE namespace = 'redeem_sellable_generation' AND scope_id = ? AND external_id = ? LIMIT 1`,
		)
		.bind(data.componentId, data.requestRef)
		.first<{ payload_digest: string }>();
	if (existing) {
		if (existing.payload_digest !== payloadDigest)
			throw new DomainError(
				"redeem_sellable_request_conflict",
				409,
				"Request reference already used",
			);
		return { idempotent: true, imported: 0, count: data.count };
	}
	const config = await loadWarehouseConfig(context);
	const batch = batchIssueEnvelopeSchema.parse(
		await requester(config.token, "/api/internal/codes/batch", {
			method: "POST",
			body: JSON.stringify({
				sku: data.sku,
				storefront: "lsrai",
				request_ref: data.requestRef,
				count: data.count,
			}),
		}),
	);
	const commerceSecret = context.runtime.commerceSecret;
	const prepared = await Promise.all(
		batch.data.codes.map(async (code) => ({
			id: crypto.randomUUID(),
			fingerprint: await fingerprintInventorySecret(code, commerceSecret),
			mask: maskInventorySecret(code),
			encrypted: await encryptSecret(
				formatInventoryDelivery(code, "https://redeem.lsrai.shop", true),
				commerceSecret,
				"stock-entry",
			),
		})),
	);
	const now = Date.now();
	const results = await context.db.batch([
		context.db
			.prepare(
				`INSERT INTO replay_receipts
				 (id, namespace, scope_id, external_id, event_type, payload_digest, status, processed_at, created_at, updated_at)
				 VALUES (?, 'redeem_sellable_generation', ?, ?, 'inventory_generation', ?, 'processed', ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				data.componentId,
				data.requestRef,
				payloadDigest,
				now,
				now,
				now,
			),
		...prepared.map((item) =>
			context.db
				.prepare(
					`INSERT OR IGNORE INTO stock_entries
					 (id, sellable_item_id, content_encrypted, key_version, content_fingerprint, content_mask,
					  status, note, created_at, updated_at)
					 VALUES (?, ?, ?, 1, ?, ?, 'available', ?, ?, ?)`,
				)
				.bind(
					item.id,
					data.componentId,
					item.encrypted,
					item.fingerprint,
					item.mask,
					`source=redeem-warehouse; sku=${data.sku}; request_ref=${data.requestRef}`,
					now,
					now,
				),
		),
		context.db
			.prepare(
				`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id, ip_address, after, created_at)
				 VALUES (?, ?, 'redeem_warehouse.sellable_inventory_generated', 'sellable_item', ?, ?, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				context.currentUser.id,
				data.componentId,
				context.request.headers.get("x-request-id"),
				context.request.headers.get("cf-connecting-ip"),
				JSON.stringify({
					sku: data.sku,
					count: data.count,
					requestRef: data.requestRef,
				}),
				now,
			),
	]);
	const imported = results
		.slice(1, 1 + prepared.length)
		.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
	return { idempotent: false, imported, count: data.count };
}

async function loadWarehouseConfig(
	context: Awaited<ReturnType<typeof getAdminRuntimeServerContext>>,
) {
	if (!context.runtime.commerceSecret) throw unavailable();
	const rows = await loadSettingRows(context.db);
	const encryptedToken = settingString(rows.get(tokenKey));
	if (!encryptedToken) throw unavailable();
	return {
		token: await decryptSecret(
			encryptedToken,
			context.runtime.commerceSecret,
			tokenPurpose,
		),
	};
}

async function loadSettingRows(db: D1Database) {
	const rows = await db
		.prepare("SELECT key, value FROM system_settings WHERE key = ?")
		.bind(tokenKey)
		.all<{ key: string; value: string }>();
	return new Map(rows.results.map((row) => [row.key, row.value]));
}

function settingString(value: string | undefined) {
	if (!value) return "";
	const parsed: unknown = JSON.parse(value);
	return typeof parsed === "string" ? parsed : "";
}

function upsertSetting(
	db: D1Database,
	key: string,
	value: string,
	secret: boolean,
	userId: string,
	now: number,
) {
	return db
		.prepare(
			`INSERT INTO system_settings (key, value, is_secret, updated_by, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_secret = excluded.is_secret,
		 updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
		)
		.bind(key, JSON.stringify(value), secret ? 1 : 0, userId, now, now);
}

export async function requestWarehouse(
	token: string,
	path: string,
	init: RequestInit = {},
	fetcher: typeof fetch = fetch,
) {
	let response: Response;
	try {
		response = await fetcher(`${warehouseBaseUrl}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${token}`,
				...(init.body ? { "Content-Type": "application/json" } : {}),
			},
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		throw new DomainError(
			"redeem_warehouse_unreachable",
			502,
			"Warehouse unavailable",
		);
	}
	const text = await response.text();
	if (text.length > 1_000_000)
		throw new DomainError(
			"redeem_warehouse_response_too_large",
			502,
			"Warehouse response too large",
		);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new DomainError(
			"redeem_warehouse_invalid_response",
			502,
			"Warehouse returned invalid data",
		);
	}
	if (!response.ok)
		throw new DomainError(
			"redeem_warehouse_request_failed",
			502,
			"Warehouse request failed",
		);
	return body;
}

function unavailable() {
	return new DomainError(
		"redeem_warehouse_unavailable",
		503,
		"Warehouse configuration unavailable",
	);
}
