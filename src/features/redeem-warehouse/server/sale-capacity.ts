import { z } from "zod";
import {
	fingerprintInventorySecret,
	formatInventoryDelivery,
	maskInventorySecret,
} from "#/features/catalog/server/inventory-secrets";
import { sha256Hex } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
import { decryptSecret, encryptSecret } from "#/lib/secrets";
import { loadRuntimeConfig } from "#/server/runtime-config";
import {
	loadDeliveryWarehouseToken,
	requestWarehouse,
} from "./warehouse-client";

// This repair is scoped to Claude Pro's shared key pool. Raw PH cards and other
// supplier/local products retain their existing fulfillment policies.
const sku = "CLAUDE_PRO_IOS";
export const SALE_CAPACITY_MAX_AGE_MS = 30_000;
const capacitySchema = z.object({
	success: z.literal(true),
	data: z.object({
		available: z.number().int().nonnegative(),
		outstanding: z.number().int().nonnegative(),
		sellable: z.number().int().nonnegative(),
	}),
});
const codePattern = /claude-pro-ios-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}/gi;

export async function claudeSaleComponent(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key='integration.supply_console_map'",
		)
		.first<{ value: string }>();
	if (!row) return null;
	let map: unknown = JSON.parse(row.value);
	if (typeof map === "string") map = JSON.parse(map);
	const parsed = z.record(z.string(), z.string()).parse(map);
	const components = Object.entries(parsed)
		.filter(([, value]) => value === sku)
		.map(([key]) => key);
	if (components.length > 1)
		throw new DomainError(
			"redeem_capacity_mapping_conflict",
			503,
			"Shared pool must have one sales authority",
		);
	return components[0] ?? null;
}

export async function refreshClaudeSaleCapacity(
	db: D1Database,
	commerceSecret?: string,
	requester: typeof requestWarehouse = requestWarehouse,
) {
	const component = await claudeSaleComponent(db);
	if (!component) return null;
	const secret = commerceSecret ?? (await loadRuntimeConfig(db)).commerceSecret;
	await db
		.prepare(
			"INSERT OR IGNORE INTO redeem_sale_capacity (component_id,free_budget,generation,updated_at) VALUES (?,0,0,0)",
		)
		.bind(component)
		.run();
	try {
		const token = await loadDeliveryWarehouseToken(db, secret);
		for (let retry = 0; retry < 3; retry++) {
			const version = await db
				.prepare(
					"SELECT generation FROM redeem_sale_capacity WHERE component_id=?",
				)
				.bind(component)
				.first<{ generation: number }>();
			if (!version) throw new Error("Capacity row missing");
			const rows = await db
				.prepare(`SELECT content_encrypted,'stock-entry' AS purpose FROM stock_entries WHERE sellable_item_id=? AND status IN ('reserved','delivered')
     UNION ALL SELECT d.content_encrypted,'delivery-content' AS purpose FROM delivery_records d JOIN shop_order_items i ON i.id=d.order_item_id WHERE i.sellable_item_id=? AND d.content_encrypted IS NOT NULL`)
				.bind(component, component)
				.all<{ content_encrypted: string; purpose: string }>();
			const missingPaid = await db
				.prepare(`SELECT COALESCE(SUM(MAX(0,i.quantity-(SELECT COUNT(*) FROM stock_entries s WHERE s.order_item_id=i.id AND s.status IN ('reserved','delivered')))),0) AS quantity
                FROM shop_order_items i JOIN shop_orders o ON o.id=i.order_id WHERE i.delivery_component_id=? AND (o.status IN ('paid','fulfilling','completed','refunding') OR (o.status='failed' AND o.paid_minor<>'0'))
                AND NOT EXISTS (SELECT 1 FROM delivery_records d WHERE d.order_item_id=i.id AND d.status='delivered')`)
				.bind(component)
				.first<{ quantity: number }>();
			const hashes = new Set<string>();
			for (const row of rows.results) {
				const content = await decryptSecret(
					row.content_encrypted,
					secret,
					row.purpose,
				);
				for (const code of content.match(codePattern) ?? [])
					hashes.add(await sha256Hex(code.toLowerCase()));
			}
			const { data } = capacitySchema.parse(
				await requester(token, "/api/internal/inventory/sale-capacity", {
					method: "POST",
					body: JSON.stringify({ sku, code_hashes: [...hashes] }),
				}),
			);
			if (data.sellable !== Math.max(0, data.available - data.outstanding))
				throw new Error("Invalid capacity arithmetic");
			// An already-paid legacy order remains an obligation even before a
			// customer code could be allocated. A failed delivery is not a refund.
			data.outstanding += Number(missingPaid?.quantity ?? 0);
			data.sellable = Math.max(0, data.available - data.outstanding);
			// A checkout changes generation in the same D1 transaction as its stock
			// reservation. Never overwrite that reservation with an older read.
			const saved = await db
				.prepare(
					"UPDATE redeem_sale_capacity SET free_budget=?,updated_at=? WHERE component_id=? AND generation=?",
				)
				.bind(data.sellable, Date.now(), component, version.generation)
				.run();
			if (saved.meta.changes === 1) return { componentId: component, ...data };
		}
		throw new Error("Capacity changed during refresh");
	} catch {
		await db
			.prepare(
				"UPDATE redeem_sale_capacity SET free_budget=0,updated_at=0,generation=generation+1 WHERE component_id=?",
			)
			.bind(component)
			.run();
		throw new DomainError(
			"redeem_sale_capacity_unavailable",
			503,
			"Verified sale capacity unavailable",
		);
	}
}

export async function prepareClaudeSale(
	db: D1Database,
	componentId: string,
	quantity: number,
) {
	if (componentId !== (await claudeSaleComponent(db))) return false;
	const runtime = await loadRuntimeConfig(db);
	const capacity = await refreshClaudeSaleCapacity(db, runtime.commerceSecret);
	if (!capacity || capacity.sellable < quantity)
		throw new DomainError(
			"inventory_unavailable",
			409,
			"Insufficient uncommitted upstream capacity",
		);
	const count = await db
		.prepare(
			"SELECT COUNT(*) AS count FROM stock_entries WHERE sellable_item_id=? AND status='available'",
		)
		.bind(componentId)
		.first<{ count: number }>();
	let missing = quantity - Number(count?.count ?? 0);
	if (missing > 0) {
		const token = await loadDeliveryWarehouseToken(db, runtime.commerceSecret);
		while (missing > 0) {
			const batchCount = Math.min(100, missing);
			const ref = `sale_pool_${crypto.randomUUID()}`;
			const batch = z
				.object({
					success: z.literal(true),
					data: z.object({
						sku: z.literal(sku),
						count: z.literal(batchCount),
						codes: z
							.array(
								z
									.string()
									.regex(/^claude-pro-ios-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/),
							)
							.length(batchCount),
					}),
				})
				.parse(
					await requestWarehouse(token, "/api/internal/codes/batch", {
						method: "POST",
						body: JSON.stringify({
							sku,
							storefront: "lsrai",
							request_ref: ref,
							count: batchCount,
						}),
					}),
				);
			if (new Set(batch.data.codes).size !== batchCount)
				throw new DomainError(
					"redeem_code_pool_invalid",
					503,
					"Invalid owned-code pool",
				);
			const entries = await Promise.all(
				batch.data.codes.map(async (code) => ({
					id: crypto.randomUUID(),
					cipher: await encryptSecret(
						formatInventoryDelivery(code, "https://redeem.lsrai.shop", true),
						runtime.commerceSecret,
						"stock-entry",
					),
					fingerprint: await fingerprintInventorySecret(
						code,
						runtime.commerceSecret,
					),
					mask: maskInventorySecret(code),
				})),
			);
			const now = Date.now();
			await db.batch(
				entries.map((e) =>
					db
						.prepare(
							"INSERT INTO stock_entries (id,sellable_item_id,content_encrypted,key_version,content_fingerprint,content_mask,status,note,created_at,updated_at,redeem_sku) VALUES (?,?,?,1,?,?,'available',?,?,?,?)",
						)
						.bind(
							e.id,
							componentId,
							e.cipher,
							e.fingerprint,
							e.mask,
							`Owned-code pool; ${ref}`,
							now,
							now,
							sku,
						),
				),
			);
			missing -= batchCount;
		}
	}
	return true;
}

// Existing paid/legacy orders need a fresh budget only when they have not
// already acquired their code hold. Other purchases do not query this pool.
export async function refreshUnheldClaudeOrder(
	db: D1Database,
	orderId: string,
) {
	const component = await claudeSaleComponent(db);
	if (!component) return;
	const unheld = await db
		.prepare(`SELECT i.id FROM shop_order_items i WHERE i.order_id=? AND i.delivery_component_id=?
  AND i.quantity>(SELECT COUNT(*) FROM stock_entries s WHERE s.order_item_id=i.id AND s.status IN ('reserved','delivered')) LIMIT 1`)
		.bind(orderId, component)
		.first();
	if (unheld) await refreshClaudeSaleCapacity(db);
}

// Keep payment statement row counts unchanged: D1 reports trigger updates in
// meta.changes, so unallocated cash obligations bump the read version explicitly
// at the end of the same financial transaction, not in a shop_orders trigger.
export function unallocatedClaudePaymentStatement(
	db: D1Database,
	orderId: string,
) {
	return db
		.prepare(`UPDATE redeem_sale_capacity SET generation=generation+1 WHERE component_id IN
   (SELECT i.delivery_component_id FROM shop_order_items i JOIN shop_orders o ON o.id=i.order_id WHERE o.id=?
    AND (o.status IN ('paid','fulfilling','completed','refunding') OR (o.status='failed' AND o.paid_minor<>'0'))
    AND i.quantity>(SELECT COUNT(*) FROM stock_entries s WHERE s.order_item_id=i.id AND s.status IN ('reserved','delivered'))
    AND NOT EXISTS (SELECT 1 FROM delivery_records d WHERE d.order_item_id=i.id AND d.status='delivered'))`)
		.bind(orderId);
}

// Used inside the order-creation D1 transaction, never as a separate preflight.
export function reserveClaudeSaleStatements(
	db: D1Database,
	componentId: string,
	orderItemId: string,
	quantity: number,
	now: number,
) {
	return [
		db
			.prepare(`UPDATE redeem_sale_capacity SET free_budget=CASE WHEN updated_at>=? AND
    (SELECT COUNT(*) FROM stock_entries WHERE sellable_item_id=? AND status='available')>=?
    AND free_budget>=? THEN free_budget ELSE -1 END WHERE component_id=?`)
			.bind(
				now - SALE_CAPACITY_MAX_AGE_MS,
				componentId,
				quantity,
				quantity,
				componentId,
			),
		db
			.prepare(
				"UPDATE stock_entries SET status='reserved',order_item_id=?,reserved_at=?,updated_at=? WHERE id IN (SELECT id FROM stock_entries WHERE sellable_item_id=? AND status='available' ORDER BY created_at,id LIMIT ?)",
			)
			.bind(orderItemId, now, now, componentId, quantity),
	];
}

export function releaseClaudeSaleStatements(
	db: D1Database,
	orderId: string,
	now: number,
) {
	return [
		db
			.prepare(`UPDATE stock_entries SET status='available',order_item_id=NULL,reserved_at=NULL,updated_at=? WHERE status='reserved'
    AND sellable_item_id IN (SELECT component_id FROM redeem_sale_capacity)
    AND order_item_id IN (SELECT i.id FROM shop_order_items i JOIN shop_orders o ON o.id=i.order_id WHERE o.id=? AND o.status IN ('cancelled','expired','failed','refunded'))`)
			.bind(now, orderId),
	];
}
