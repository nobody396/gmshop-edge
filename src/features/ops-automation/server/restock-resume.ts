import { z } from "zod";
import { type ProcurementPrices, settingStatement } from "./shared";

/**
 * Specs the owner paused because their supplier sold out (2026-11-08: ChatGPT Go
 * iOS when 86 ran dry). The daily pricing run resumes each one as soon as its
 * supplier lists stock again; until then it stays paused. Only items in this
 * list are ever resumed: a spec paused for any other reason is never touched.
 */
export const restockResumeSettingKey = "pricing.restock_resume_items";

const itemsSchema = z.array(z.string().min(1)).max(200);

export function parseRestockResumeItems(value: unknown): string[] {
	const parsed = itemsSchema.safeParse(value);
	return parsed.success ? [...new Set(parsed.data)] : [];
}

export type RestockResumeOutcome = {
	itemId: string;
	label: string;
	sku: string;
	stock: number;
	resumed: boolean;
};

/** Which listed items the supplier can serve again (listed stock > 0). Unknown stock waits. */
export function restockedItems(
	itemIds: string[],
	map: Record<string, string>,
	prices: ProcurementPrices | null,
) {
	const ready: { itemId: string; sku: string; stock: number }[] = [];
	for (const itemId of itemIds) {
		const sku = map[itemId];
		const stock = sku
			? prices?.find((entry) => entry.sku === sku)?.stock
			: undefined;
		if (sku && typeof stock === "number" && stock > 0)
			ready.push({ itemId, sku, stock });
	}
	return ready;
}

/**
 * Resumes the listed items whose supplier has stock again, then rewrites the
 * list without them. Items no longer paused (the owner resumed one by hand)
 * also leave the list.
 */
export async function resumeRestockedItems(
	db: D1Database,
	input: {
		value: unknown;
		map: Record<string, string>;
		prices: ProcurementPrices | null;
		now: number;
	},
): Promise<RestockResumeOutcome[]> {
	const listed = parseRestockResumeItems(input.value);
	if (listed.length === 0) return [];
	const outcomes: RestockResumeOutcome[] = [];
	const keep = new Set(listed);
	for (const ready of restockedItems(listed, input.map, input.prices)) {
		const row = await db
			.prepare(
				`SELECT item.id, item.version, item.sale_disabled, item.product_id,
				        product.name AS product_name, item.name AS item_name
				 FROM product_sellable_items item JOIN products product ON product.id = item.product_id
				 WHERE item.id = ? LIMIT 1`,
			)
			.bind(ready.itemId)
			.first<{
				id: string;
				version: number;
				sale_disabled: number;
				product_id: string;
				product_name: string;
				item_name: string;
			}>();
		if (!row) {
			keep.delete(ready.itemId);
			continue;
		}
		const label = `${row.product_name} · ${row.item_name}`;
		if (Number(row.sale_disabled) !== 1) {
			keep.delete(ready.itemId);
			continue;
		}
		const landed =
			"EXISTS (SELECT 1 FROM product_sellable_items WHERE id = ? AND version = ? AND sale_disabled = 0)";
		const landedArgs = [row.id, Number(row.version) + 1] as const;
		const [result] = await db.batch([
			db
				.prepare(
					`UPDATE product_sellable_items SET sale_disabled = 0, version = version + 1, updated_at = ?
					 WHERE id = ? AND version = ? AND sale_disabled = 1`,
				)
				.bind(input.now, row.id, row.version),
			db
				.prepare(
					`UPDATE products SET revision = revision + 1, revision_token = ?, updated_at = ?
					 WHERE id = ? AND ${landed}`,
				)
				.bind(crypto.randomUUID(), input.now, row.product_id, ...landedArgs),
			// Bumping the listing's updated_at makes lsrai.shop pick the change up.
			db
				.prepare(
					`UPDATE supplier_export_listings SET updated_at = ? WHERE sellable_item_id = ? AND ${landed}`,
				)
				.bind(input.now, row.id, ...landedArgs),
			db
				.prepare(
					`INSERT INTO audit_logs (id, action, target_type, target_id, before, after, created_at)
					 SELECT ?, 'pricing_guard.restock_resumed', 'sellable_item', ?, ?, ?, ? WHERE ${landed}`,
				)
				.bind(
					crypto.randomUUID(),
					row.id,
					JSON.stringify({ saleDisabled: true, version: row.version }),
					JSON.stringify({
						saleDisabled: false,
						version: Number(row.version) + 1,
						sku: ready.sku,
						supplierStock: ready.stock,
					}),
					input.now,
					...landedArgs,
				),
		]);
		const resumed = Number(result?.meta.changes ?? 0) === 1;
		if (resumed) keep.delete(ready.itemId);
		outcomes.push({ ...ready, label, resumed });
	}
	if (keep.size !== listed.length)
		await settingStatement(
			db,
			restockResumeSettingKey,
			[...keep],
			input.now,
		).run();
	return outcomes;
}

export function formatRestockResumeLines(outcomes: RestockResumeOutcome[]) {
	return outcomes.map((outcome) =>
		outcome.resumed
			? `✅ 上游已补货（库存 ${outcome.stock}），已自动恢复售卖：${outcome.label}`
			: `⚠️ 上游已补货（库存 ${outcome.stock}），但恢复售卖没写进去，明天再试：${outcome.label}`,
	);
}
