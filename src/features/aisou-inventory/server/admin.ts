import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { normalizeInventorySecrets } from "#/features/catalog/server/inventory-secrets";
import {
	importRestockBatch,
	type RestockRequest,
} from "#/features/catalog/server/restock-api";
import { DomainError } from "#/lib/domain-error";
import { decimalToMinor } from "#/lib/units";
import { getAdminRuntimeServerContext } from "#/server/context";

const source = "aisou";
const sourceCondition = `(stock.procurement_source = 'aisou'
	OR (stock.procurement_source IS NULL AND lower(coalesce(stock.note, '')) LIKE '%source=aisou%'))`;

const importSchema = z.object({
	requestRef: z
		.string()
		.trim()
		.regex(/^[A-Za-z0-9_-]{16,100}$/),
	componentId: z.uuid(),
	unitCostYuan: z
		.string()
		.trim()
		.regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/),
	content: z.string().trim().min(1).max(250_000),
	usageUrl: z
		.url()
		.max(2_048)
		.refine((value) => {
			const url = new URL(value);
			return (
				url.protocol === "https:" &&
				!url.username &&
				!url.password &&
				![...url.searchParams.keys()].some((key) =>
					/^(?:token|api_key|key|sign|authorization|password|secret)$/i.test(
						key,
					),
				)
			);
		}),
});

type InventoryRow = {
	component_id: string;
	product_name: string;
	item_name: string;
	available: number | null;
	reserved: number | null;
	delivered: number | null;
	disabled: number | null;
	costed_available: number | null;
	available_value_minor: number | null;
	latest_unit_cost_minor: string | null;
	last_restocked_at: number | null;
};

export const listAisouInventoryFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("inventory", "read"),
		);
		return listAisouInventory(context.db);
	},
);

export async function listAisouInventory(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT item.id AS component_id, product.name AS product_name,
				 item.name AS item_name,
				 SUM(CASE WHEN stock.status = 'available' THEN 1 ELSE 0 END) AS available,
				 SUM(CASE WHEN stock.status = 'reserved' THEN 1 ELSE 0 END) AS reserved,
				 SUM(CASE WHEN stock.status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
				 SUM(CASE WHEN stock.status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
				 SUM(CASE WHEN stock.status = 'available' AND stock.unit_cost_minor IS NOT NULL
				     THEN 1 ELSE 0 END) AS costed_available,
				 SUM(CASE WHEN stock.status = 'available' AND stock.unit_cost_minor IS NOT NULL
				     THEN CAST(stock.unit_cost_minor AS INTEGER) ELSE 0 END) AS available_value_minor,
				 (SELECT latest.unit_cost_minor FROM stock_entries latest
				   WHERE latest.sellable_item_id = item.id
				    AND latest.unit_cost_minor IS NOT NULL
				    AND (latest.procurement_source = 'aisou'
				     OR (latest.procurement_source IS NULL
				      AND lower(coalesce(latest.note, '')) LIKE '%source=aisou%'))
				   ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1) AS latest_unit_cost_minor,
				 MAX(stock.created_at) AS last_restocked_at
				 FROM product_sellable_items item
				 JOIN products product ON product.id = item.product_id
				 LEFT JOIN stock_entries stock ON stock.sellable_item_id = item.id
				  AND ${sourceCondition}
				 WHERE product.status = 'active' AND product.product_type = 'stock'
				  AND item.enabled = 1
				  AND ((item.fulfillment_source = 'local' AND EXISTS (
				   SELECT 1 FROM supplier_bindings binding
				    WHERE binding.sellable_item_id = item.id AND binding.enabled = 1
				     AND binding.provider = 'shared_stock')) OR stock.id IS NOT NULL)
				 GROUP BY item.id, product.name, item.name
				 ORDER BY product.sort_order, item.sort_order, item.name`,
		)
		.all<InventoryRow>();
	return rows.results.map((row) => ({
		componentId: row.component_id,
		productName: row.product_name,
		itemName: row.item_name,
		available: Number(row.available ?? 0),
		reserved: Number(row.reserved ?? 0),
		delivered: Number(row.delivered ?? 0),
		disabled: Number(row.disabled ?? 0),
		costedAvailable: Number(row.costed_available ?? 0),
		availableValueMinor: String(row.available_value_minor ?? 0),
		latestUnitCostMinor: row.latest_unit_cost_minor,
		lastRestockedAt: row.last_restocked_at,
	}));
}

export const importAisouInventoryFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof importSchema>) => importSchema.parse(input))
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("inventory", "create"),
		);
		return importAisouInventory(data, context);
	});

export async function importAisouInventory(
	data: z.infer<typeof importSchema>,
	context: { db: D1Database; request: Request },
) {
	const target = await context.db
		.prepare(
			`SELECT item.id FROM product_sellable_items item
				 JOIN products product ON product.id = item.product_id
				 JOIN supplier_bindings binding ON binding.sellable_item_id = item.id
				 WHERE item.id = ? AND item.enabled = 1 AND product.status = 'active'
				  AND product.product_type = 'stock' AND binding.enabled = 1
				  AND binding.provider = 'shared_stock'
				  AND (item.fulfillment_source = 'local' OR EXISTS (
				   SELECT 1 FROM stock_entries stock WHERE stock.sellable_item_id = item.id
				    AND (stock.procurement_source = 'aisou'
				     OR (stock.procurement_source IS NULL
				      AND lower(coalesce(stock.note, '')) LIKE '%source=aisou%')))) LIMIT 1`,
		)
		.bind(data.componentId)
		.first<{ id: string }>();
	if (!target)
		throw new DomainError(
			"aisou_inventory_target_not_found",
			404,
			"AISOU-backed stock item not found",
		);
	const lines = data.content
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter(Boolean);
	const secrets = normalizeInventorySecrets(data.content);
	if (secrets.length !== lines.length)
		throw new DomainError(
			"aisou_inventory_duplicate_input",
			400,
			"Duplicate cards are not accepted",
		);
	if (secrets.length > 90)
		throw new DomainError(
			"aisou_inventory_batch_too_large",
			400,
			"Import at most 90 cards",
		);
	const request: RestockRequest = {
		requestRef: data.requestRef,
		componentId: data.componentId,
		secrets,
		usageUrl: data.usageUrl,
		source,
		unitCostMinor: decimalToMinor(data.unitCostYuan, 2).toString(),
		note: "AISOU批量采购",
	};
	const result = await importRestockBatch(context.db, context.request, request);
	return {
		imported: result.imported,
		duplicates: result.duplicates,
		idempotent: result.idempotent,
	};
}
