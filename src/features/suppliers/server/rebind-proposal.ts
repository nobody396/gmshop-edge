import { z } from "zod";
import { formatYuan } from "#/features/ops-automation/server/shared";
import type { OwnerActionContext } from "#/features/telegram/server/owner-actions";
import { DomainError } from "#/lib/domain-error";
import type { SupplierProduct } from "../providers/types";
import {
	assertSupplierSkuUnbound,
	loadSwitchTarget,
	switchSupplierBindingStatements,
} from "./binding-switch";
import {
	readCachedSupplierCatalog,
	type SupplierSourceIdentity,
} from "./source-sync";

export type DelistedBinding = {
	bindingId: string;
	sellableItemId: string;
	productName: string;
	sellableItemName: string;
	upstreamProductId: string;
	upstreamProductName: string;
	upstreamSkuName: string;
	maxCostMinor: string;
	priceMinor: string;
};

export type RebindCandidate = {
	product: SupplierProduct;
	sku: SupplierProduct["skus"][number];
};

const maxCandidates = 3;

/** Same upstream product and SKU name, ignoring width, case and spacing. */
export function findRebindCandidates(
	delisted: DelistedBinding,
	products: SupplierProduct[],
	boundKeys: Set<string>,
) {
	const productName = normalizeName(delisted.upstreamProductName);
	const skuName = normalizeName(delisted.upstreamSkuName);
	const candidates: RebindCandidate[] = [];
	for (const product of products) {
		if (!product.active || normalizeName(product.name) !== productName)
			continue;
		for (const sku of product.skus)
			if (
				sku.active &&
				normalizeName(sku.name) === skuName &&
				!boundKeys.has(`${product.id}\0${sku.id}`)
			)
				candidates.push({ product, sku });
	}
	return candidates
		.sort((left, right) => right.sku.stockQuantity - left.sku.stockQuantity)
		.slice(0, maxCandidates);
}

export function affordable(candidate: RebindCandidate, maxCostMinor: string) {
	return BigInt(candidate.sku.costMinor) <= BigInt(maxCostMinor);
}

export function formatRebindProposal(
	origin: string,
	delisted: DelistedBinding,
	candidates: RebindCandidate[],
) {
	const lines = [
		`⚠️ 上游换了商品（${new URL(origin).host}）：${delisted.productName}｜${delisted.sellableItemName}`,
		`旧：${delisted.upstreamProductName}（编号 ${delisted.upstreamProductId}，已下架，已自动停售）`,
	];
	// Only choosable candidates are numbered, in the same order as the buttons.
	const choosable = candidates.filter((candidate) =>
		affordable(candidate, delisted.maxCostMinor),
	);
	const line = (candidate: RebindCandidate, tag: string, suffix = "") => {
		const cost = BigInt(candidate.sku.costMinor);
		return `${tag}：${candidate.product.name}（编号 ${candidate.product.id}）进价 ${formatYuan(cost)}，库存 ${candidate.sku.stockQuantity}，每单毛利 ${formatYuan(BigInt(delisted.priceMinor) - cost)}${suffix}`;
	};
	choosable.forEach((candidate, index) => {
		lines.push(line(candidate, choosable.length > 1 ? `新${index + 1}` : "新"));
	});
	for (const candidate of candidates)
		if (!choosable.includes(candidate))
			lines.push(
				line(
					candidate,
					"另有",
					`，超过进价上限 ${formatYuan(BigInt(delisted.maxCostMinor))}，不可选`,
				),
			);
	lines.push(`售价 ${formatYuan(BigInt(delisted.priceMinor))}（基础价）`);
	return lines.join("\n");
}

export function rebindChoiceLabel(
	candidates: RebindCandidate[],
	index: number,
) {
	return candidates.length > 1 ? `✅ 换成新${index + 1}` : "✅ 换上游";
}

export const rebindPayloadSchema = z.object({
	sellableItemId: z.string(),
	oldBindingId: z.string(),
	source: z.object({
		provider: z.enum(["acg", "dujiao_next", "gmshop_edge", "shared_stock"]),
		normalizedApiOrigin: z.string(),
		protocolVersion: z.string(),
	}),
	candidates: z.array(z.object({ productId: z.string(), skuId: z.string() })),
});

export function rebindPayload(
	source: SupplierSourceIdentity,
	delisted: DelistedBinding,
	candidates: RebindCandidate[],
): z.infer<typeof rebindPayloadSchema> {
	return {
		sellableItemId: delisted.sellableItemId,
		oldBindingId: delisted.bindingId,
		source,
		candidates: candidates.map(({ product, sku }) => ({
			productId: product.id,
			skuId: sku.id,
		})),
	};
}

/** Re-checks everything against the latest catalog before switching. */
export async function approveSupplierRebind(
	context: OwnerActionContext,
	rawPayload: unknown,
	choice: number,
) {
	const payload = rebindPayloadSchema.parse(rawPayload);
	const chosen = payload.candidates[choice];
	if (!chosen) throw rebindError("选项无效");
	const [catalog, target] = await Promise.all([
		readCachedSupplierCatalog(context.cache, payload.source),
		loadSwitchTarget(context.db, payload.sellableItemId),
	]);
	if (!catalog) throw rebindError("上游商品目录缓存不可用");
	if (!target || target.binding_id !== payload.oldBindingId)
		throw rebindError("这个规格的货源已经变过了");
	const product = catalog.products.find((item) => item.id === chosen.productId);
	const sku = product?.skus.find((item) => item.id === chosen.skuId);
	if (!product || !sku || !product.active || !sku.active)
		throw rebindError("新商品已经不在售");
	if (BigInt(sku.costMinor) > BigInt(target.max_cost_minor))
		throw rebindError(
			`新进价 ${formatYuan(BigInt(sku.costMinor))} 超过上限 ${formatYuan(BigInt(target.max_cost_minor))}`,
		);
	try {
		await assertSupplierSkuUnbound(
			context.db,
			payload.source,
			product.id,
			sku.id,
		);
	} catch {
		throw rebindError("新商品已经绑在别的规格上");
	}
	const { bindingId, statements } = switchSupplierBindingStatements(
		context.db,
		{
			target,
			source: payload.source,
			product,
			sku,
			syncedAt: catalog.syncedAt,
			maxCostMinor: target.max_cost_minor,
			now: context.now,
		},
	);
	await context.db.batch([
		...statements,
		context.db
			.prepare(
				`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id,
				  ip_address, before, after, created_at)
				 VALUES (?, NULL, 'supplier_binding.switched', 'supplier_binding', ?,
				  NULL, NULL, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				bindingId,
				JSON.stringify({ bindingId: target.binding_id }),
				JSON.stringify({
					...payload.source,
					productId: product.id,
					skuId: sku.id,
					via: "telegram_owner_action",
				}),
				context.now,
			),
	]);
	return `✅ 已换上游：编号 ${product.id}，进价 ${formatYuan(BigInt(sku.costMinor))}，库存 ${sku.stockQuantity}，已恢复销售`;
}

function rebindError(message: string) {
	return new DomainError("supplier_rebind_rejected", 409, message);
}

function normalizeName(value: string) {
	return value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

// ---- Cost rose past the cap: resume at the new cost ----

export type CostCappedBinding = {
	bindingId: string;
	sellableItemId: string;
	productName: string;
	sellableItemName: string;
	upstreamProductId: string;
	upstreamSkuId: string;
	upstreamProductName: string;
	previousCostMinor: string;
	costMinor: string;
	maxCostMinor: string;
	priceMinor: string;
	stockQuantity: number;
};

export function formatCostCapProposal(origin: string, item: CostCappedBinding) {
	const cost = BigInt(item.costMinor);
	return [
		`⚠️ 上游涨价，已自动停售（${new URL(origin).host}）：${item.productName}｜${item.sellableItemName}`,
		`上游：${item.upstreamProductName}（编号 ${item.upstreamProductId}）`,
		`进价 ${formatYuan(BigInt(item.previousCostMinor))} → ${formatYuan(cost)}，超过上限 ${formatYuan(BigInt(item.maxCostMinor))}`,
		`库存 ${item.stockQuantity}，售价 ${formatYuan(BigInt(item.priceMinor))}（基础价），按新进价每单毛利 ${formatYuan(BigInt(item.priceMinor) - cost)}`,
		`恢复销售会把进价上限改成 ${formatYuan(cost)}，售价不变。`,
	].join("\n");
}

const costCapPayloadSchema = z.object({
	sellableItemId: z.string(),
	bindingId: z.string(),
	productId: z.string(),
	skuId: z.string(),
	costMinor: z.string().regex(/^(0|[1-9]\d*)$/),
	source: rebindPayloadSchema.shape.source,
});

export function costCapPayload(
	source: SupplierSourceIdentity,
	item: CostCappedBinding,
): z.infer<typeof costCapPayloadSchema> {
	return {
		sellableItemId: item.sellableItemId,
		bindingId: item.bindingId,
		productId: item.upstreamProductId,
		skuId: item.upstreamSkuId,
		costMinor: item.costMinor,
		source,
	};
}

/** Raises the cap to the cost the owner saw; refuses if the cost went higher. */
export async function approveSupplierCostCap(
	context: OwnerActionContext,
	rawPayload: unknown,
) {
	const payload = costCapPayloadSchema.parse(rawPayload);
	const [catalog, target] = await Promise.all([
		readCachedSupplierCatalog(context.cache, payload.source),
		loadSwitchTarget(context.db, payload.sellableItemId),
	]);
	if (!catalog) throw rebindError("上游商品目录缓存不可用");
	if (!target || target.binding_id !== payload.bindingId)
		throw rebindError("这个规格的货源已经变过了");
	const product = catalog.products.find(
		(item) => item.id === payload.productId,
	);
	const sku = product?.skus.find((item) => item.id === payload.skuId);
	if (!product || !sku || !product.active || !sku.active)
		throw rebindError("上游商品已经不在售");
	if (BigInt(sku.costMinor) > BigInt(payload.costMinor))
		throw rebindError(
			`进价又涨到 ${formatYuan(BigInt(sku.costMinor))}，比提醒里的高`,
		);
	const [updated] = await context.db.batch([
		context.db
			.prepare(
				`UPDATE supplier_bindings SET max_cost_minor = ?, updated_at = ?
				 WHERE id = ? AND enabled = 1`,
			)
			.bind(payload.costMinor, context.now, payload.bindingId),
		context.db
			.prepare(
				`UPDATE product_sellable_items SET supplier_status = 'available',
				 updated_at = ? WHERE id = ? AND fulfillment_source = 'supplier'
				 AND EXISTS (SELECT 1 FROM supplier_bindings WHERE id = ?
				  AND enabled = 1 AND max_cost_minor = ?)`,
			)
			.bind(
				context.now,
				payload.sellableItemId,
				payload.bindingId,
				payload.costMinor,
			),
		context.db
			.prepare(
				`INSERT INTO audit_logs
				 (id, actor_user_id, action, target_type, target_id, request_id,
				  ip_address, before, after, created_at)
				 VALUES (?, NULL, 'supplier_binding.cost_cap_raised',
				  'supplier_binding', ?, NULL, NULL, ?, ?, ?)`,
			)
			.bind(
				crypto.randomUUID(),
				payload.bindingId,
				JSON.stringify({ maxCostMinor: target.max_cost_minor }),
				JSON.stringify({
					maxCostMinor: payload.costMinor,
					via: "telegram_owner_action",
				}),
				context.now,
			),
	]);
	if (Number(updated?.meta.changes ?? 0) !== 1)
		throw rebindError("这个规格的货源已经变过了");
	return `✅ 已恢复销售：进价上限改为 ${formatYuan(BigInt(payload.costMinor))}，当前进价 ${formatYuan(BigInt(sku.costMinor))}，库存 ${sku.stockQuantity}`;
}
