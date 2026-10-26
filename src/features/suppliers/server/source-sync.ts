import { z } from "zod";
import { runTrackedTask } from "#/features/operations/server/task-runs";
import { proposeOwnerAction } from "#/features/telegram/server/owner-actions";
import { sendOwnerAlert } from "#/features/telegram/server/owner-alerts";
import { DomainError } from "#/lib/domain-error";
import type { RuntimeConfig } from "#/server/runtime-config";
import type { SupplierProduct } from "../providers/types";
import type { SupplierProvider } from "../schema";
import {
	adapterForSupplierAccount,
	type SupplierAccountRuntimeRow,
} from "./account-runtime";
import { claimSupplierApiBudget } from "./rate-limit";
import {
	affordable,
	type CostCappedBinding,
	costCapPayload,
	type DelistedBinding,
	findRebindCandidates,
	formatCostCapProposal,
	formatRebindProposal,
	rebindChoiceLabel,
	rebindPayload,
} from "./rebind-proposal";

const CATALOG_SYNC_WINDOW_MS = 10 * 60_000;
const CATALOG_CACHE_TTL_SECONDS = 15 * 60;
const MAX_CATALOG_PRODUCTS = 10_000;

const cachedCatalogSchema = z.object({
	version: z.literal(1),
	provider: z.enum(["acg", "dujiao_next", "gmshop_edge", "shared_stock"]),
	normalizedApiOrigin: z.string(),
	protocolVersion: z.string(),
	syncedAt: z.number().int().nonnegative(),
	products: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			description: z.string(),
			imageUrls: z.array(z.string()).max(20),
			categoryNames: z.array(z.string()).max(100),
			active: z.boolean(),
			updatedAt: z.string().nullable().optional(),
			skus: z.array(
				z.object({
					id: z.string(),
					name: z.string(),
					costMinor: z.string().regex(/^(0|[1-9]\d*)$/),
					stockQuantity: z.number().int().nonnegative(),
					active: z.boolean(),
				}),
			),
		}),
	),
});

export type SupplierSourceIdentity = {
	provider: SupplierProvider;
	normalizedApiOrigin: string;
	protocolVersion: string;
};

type SourceAccountRow = SupplierAccountRuntimeRow & {
	normalized_api_origin: string;
	protocol_version: string;
	health_status: string;
	consecutive_failures: number;
	cooldown_until: number | null;
	last_selected_at: number | null;
};

export async function syncSupplierSource(input: {
	db: D1Database;
	cache?: KVNamespace;
	runtime: Pick<RuntimeConfig, "commerceSecret">;
	source: SupplierSourceIdentity;
	trigger: "manual" | "scheduled";
	full?: boolean;
	now?: number;
	fetcher?: typeof fetch;
}) {
	const now = input.now ?? Date.now();
	const task = await sourceSyncTaskName(input.source, now, input.full);
	const completed = await input.db
		.prepare(
			`SELECT id FROM operation_task_runs
			 WHERE task = ? AND status = 'succeeded' LIMIT 1`,
		)
		.bind(task)
		.first();
	if (completed) return { skipped: true, reason: "already_synced" } as const;

	return runTrackedTask(
		input.db,
		{ task, trigger: input.trigger, now },
		async () => {
			const accounts = await sourceAccounts(input.db, input.source, now);
			if (!accounts.length)
				throw new DomainError(
					"supplier_source_has_no_account",
					409,
					"Supplier source has no eligible account",
				);
			const previousCatalog = await readCachedSupplierCatalog(
				input.cache,
				input.source,
			);
			const incremental =
				!input.full &&
				input.source.provider === "dujiao_next" &&
				previousCatalog !== null &&
				isSameUtcDay(previousCatalog.syncedAt, now);
			const { products: fetchedProducts, accountId } =
				await loadCatalogFromAnyAccount(
					input.db,
					accounts,
					input.runtime,
					now,
					input.fetcher,
					incremental ? latestProductUpdate(previousCatalog.products) : null,
				);
			const products = incremental
				? mergeCatalog(previousCatalog.products, fetchedProducts)
				: fetchedProducts;
			const { delisted, boundKeys, costCapped } = await updateBoundProducts(
				input.db,
				input.source,
				products,
				now,
			);
			await writeCachedSupplierCatalog(input.cache, input.source, {
				version: 1,
				...input.source,
				syncedAt: now,
				products,
			});
			// Best effort: a failed alert must not fail the catalog sync.
			if (costCapped.length)
				await notifyCostCappedBindings({
					db: input.db,
					source: input.source,
					costCapped,
					now,
					fetcher: input.fetcher,
				}).catch(() => undefined);
			if (delisted.length)
				await notifyDelistedBindings({
					db: input.db,
					source: input.source,
					delisted,
					products,
					boundKeys,
					now,
					fetcher: input.fetcher,
				}).catch(() => undefined);
			return {
				skipped: false,
				accountId,
				productCount: products.length,
				skuCount: products.reduce(
					(total, product) => total + product.skus.length,
					0,
				),
			} as const;
		},
	);
}

export async function readCachedSupplierCatalog(
	cache: KVNamespace | undefined,
	source: SupplierSourceIdentity,
) {
	if (!cache) return null;
	try {
		const value = await cache.get(await sourceCatalogCacheKey(source), "json");
		return value == null ? null : cachedCatalogSchema.parse(value);
	} catch {
		return null;
	}
}

async function loadCatalogFromAnyAccount(
	db: D1Database,
	accounts: SourceAccountRow[],
	runtime: Pick<RuntimeConfig, "commerceSecret">,
	now: number,
	fetcher?: typeof fetch,
	updatedAfter?: string | null,
) {
	for (const account of accounts) {
		try {
			await claimSupplierApiBudget(db, {
				provider: account.provider,
				normalizedApiOrigin: account.normalized_api_origin,
				protocolVersion: account.protocol_version,
				accountId: account.id,
				now,
			});
			const adapter = await adapterForSupplierAccount(account, runtime, {
				fetcher,
			});
			const products = await allProducts(
				account.provider,
				adapter,
				updatedAfter,
			);
			await db
				.prepare(
					`UPDATE supplier_accounts SET health_status = 'healthy',
					 consecutive_failures = 0, cooldown_until = NULL,
					 last_error_code = NULL, updated_at = ? WHERE id = ?`,
				)
				.bind(now, account.id)
				.run();
			return { products, accountId: account.id };
		} catch {
			await db
				.prepare(
					`UPDATE supplier_accounts SET health_status = 'degraded',
					 consecutive_failures = consecutive_failures + 1,
					 cooldown_until = ?, last_error_code = 'catalog_sync_failed',
					 last_error_at = ?, updated_at = ? WHERE id = ?`,
				)
				.bind(now + 60_000, now, now, account.id)
				.run();
		}
	}
	throw new DomainError(
		"supplier_catalog_sync_failed",
		502,
		"Supplier catalog synchronization failed",
	);
}

async function allProducts(
	provider: SupplierProvider,
	adapter: Awaited<ReturnType<typeof adapterForSupplierAccount>>,
	updatedAfter?: string | null,
) {
	const pageSize = provider === "acg" ? MAX_CATALOG_PRODUCTS : 50;
	const products: SupplierProduct[] = [];
	let page = 1;
	while (products.length < MAX_CATALOG_PRODUCTS) {
		const result = await adapter.listProducts({
			page,
			pageSize,
			includeInactive: true,
			updatedAfter:
				provider === "dujiao_next" ? (updatedAfter ?? undefined) : undefined,
		});
		products.push(...result.products);
		if (
			products.length >= result.total ||
			result.products.length === 0 ||
			provider === "acg"
		)
			break;
		page += 1;
	}
	if (products.length > MAX_CATALOG_PRODUCTS)
		throw new DomainError(
			"supplier_catalog_too_large",
			502,
			"Supplier catalog exceeds the supported size",
		);
	return products;
}

function latestProductUpdate(products: SupplierProduct[]) {
	return products.reduce<string | null>((latest, product) => {
		if (!product.updatedAt) return latest;
		return latest == null || product.updatedAt > latest
			? product.updatedAt
			: latest;
	}, null);
}

function mergeCatalog(previous: SupplierProduct[], updates: SupplierProduct[]) {
	const merged = new Map(previous.map((product) => [product.id, product]));
	for (const product of updates) merged.set(product.id, product);
	return [...merged.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
}

function isSameUtcDay(left: number, right: number) {
	return (
		new Date(left).toISOString().slice(0, 10) ===
		new Date(right).toISOString().slice(0, 10)
	);
}

async function updateBoundProducts(
	db: D1Database,
	source: SupplierSourceIdentity,
	products: SupplierProduct[],
	now: number,
) {
	const seen = new Set<string>();
	const statements: D1PreparedStatement[] = [];
	for (const product of products) {
		for (const sku of product.skus) {
			seen.add(`${product.id}\0${sku.id}`);
			const remoteStatus = product.active && sku.active ? "active" : "inactive";
			statements.push(
				db
					.prepare(
						`UPDATE supplier_bindings SET upstream_product_name = ?,
						 upstream_sku_name = ?, reference_cost_minor = ?,
						 stock_quantity = ?, remote_status = ?, last_synced_at = ?,
						 last_error_code = NULL, updated_at = ?
						 WHERE provider = ? AND normalized_api_origin = ?
						 AND protocol_version = ? AND upstream_product_id = ?
						 AND upstream_sku_id = ? AND enabled = 1`,
					)
					.bind(
						product.name,
						sku.name,
						sku.costMinor,
						sku.stockQuantity,
						remoteStatus,
						now,
						now,
						source.provider,
						source.normalizedApiOrigin,
						source.protocolVersion,
						product.id,
						sku.id,
					),
				db
					.prepare(
						`UPDATE product_sellable_items SET supplier_status =
						 CASE WHEN product_sellable_items.fulfillment_source <> 'supplier'
						 THEN NULL WHEN ? = 'active' AND (
						  LENGTH(?) < LENGTH(sb.max_cost_minor) OR
						  (LENGTH(?) = LENGTH(sb.max_cost_minor) AND ? <= sb.max_cost_minor)
						 ) THEN 'available' ELSE 'unavailable' END,
						 updated_at = ?
						 FROM supplier_bindings sb
						 WHERE sb.sellable_item_id = product_sellable_items.id
						 AND sb.provider = ? AND sb.normalized_api_origin = ?
						 AND sb.protocol_version = ? AND sb.upstream_product_id = ?
						 AND sb.upstream_sku_id = ? AND sb.enabled = 1`,
					)
					.bind(
						remoteStatus,
						sku.costMinor,
						sku.costMinor,
						sku.costMinor,
						now,
						source.provider,
						source.normalizedApiOrigin,
						source.protocolVersion,
						product.id,
						sku.id,
					),
			);
		}
	}
	const bindings = await db
		.prepare(
			`SELECT sb.id, sb.sellable_item_id, sb.upstream_product_id,
			        sb.upstream_sku_id, sb.upstream_product_name,
			        sb.upstream_sku_name, sb.max_cost_minor, sb.reference_cost_minor,
			        sb.last_error_code, psi.name AS sellable_item_name,
			        psi.price_minor, psi.supplier_status, psi.fulfillment_source,
			        p.name AS product_name,
			        CASE WHEN psi.fulfillment_source = 'supplier' AND psi.enabled = 1
			         AND psi.sale_disabled = 0 AND p.status = 'active'
			         AND p.sale_disabled = 0 THEN 1 ELSE 0 END AS on_sale
			 FROM supplier_bindings sb
			 JOIN product_sellable_items psi ON psi.id = sb.sellable_item_id
			 JOIN products p ON p.id = psi.product_id
			 WHERE sb.provider = ? AND sb.normalized_api_origin = ?
			 AND sb.protocol_version = ? AND sb.enabled = 1`,
		)
		.bind(source.provider, source.normalizedApiOrigin, source.protocolVersion)
		.all<{
			id: string;
			sellable_item_id: string;
			upstream_product_id: string;
			upstream_sku_id: string;
			upstream_product_name: string;
			upstream_sku_name: string;
			max_cost_minor: string;
			reference_cost_minor: string;
			last_error_code: string | null;
			sellable_item_name: string;
			price_minor: string;
			supplier_status: string | null;
			fulfillment_source: string;
			product_name: string;
			on_sale: number;
		}>();
	const delisted: DelistedBinding[] = [];
	const boundKeys = new Set(
		bindings.results.map(
			(binding) => `${binding.upstream_product_id}\0${binding.upstream_sku_id}`,
		),
	);
	const catalogSkus = new Map(
		products.flatMap((product) =>
			product.skus.map((sku) => [`${product.id}\0${sku.id}`, { product, sku }]),
		),
	);
	// Read before the batch below runs, so supplier_status is still the old one.
	const costCapped: CostCappedBinding[] = [];
	for (const binding of bindings.results) {
		const listed = catalogSkus.get(
			`${binding.upstream_product_id}\0${binding.upstream_sku_id}`,
		);
		if (
			listed?.product.active &&
			listed.sku.active &&
			binding.on_sale === 1 &&
			binding.supplier_status === "available" &&
			BigInt(listed.sku.costMinor) > BigInt(binding.max_cost_minor)
		)
			costCapped.push({
				bindingId: binding.id,
				sellableItemId: binding.sellable_item_id,
				productName: binding.product_name,
				sellableItemName: binding.sellable_item_name,
				upstreamProductId: binding.upstream_product_id,
				upstreamSkuId: binding.upstream_sku_id,
				upstreamProductName: listed.product.name,
				previousCostMinor: binding.reference_cost_minor,
				costMinor: listed.sku.costMinor,
				maxCostMinor: binding.max_cost_minor,
				priceMinor: binding.price_minor,
				stockQuantity: listed.sku.stockQuantity,
			});
	}
	for (const binding of bindings.results) {
		if (seen.has(`${binding.upstream_product_id}\0${binding.upstream_sku_id}`))
			continue;
		// A deleted binding stays deleted; it used to flip back to
		// "missing once" on the next sync and get re-confirmed every other run.
		const confirmed =
			binding.last_error_code === "supplier_sku_missing_once" ||
			binding.last_error_code === "supplier_sku_deleted";
		// Only SKUs on sale and fulfilled by this supplier are worth the owner's attention.
		if (
			binding.last_error_code === "supplier_sku_missing_once" &&
			binding.on_sale === 1
		)
			delisted.push({
				bindingId: binding.id,
				sellableItemId: binding.sellable_item_id,
				productName: binding.product_name,
				sellableItemName: binding.sellable_item_name,
				upstreamProductId: binding.upstream_product_id,
				upstreamProductName: binding.upstream_product_name,
				upstreamSkuName: binding.upstream_sku_name,
				maxCostMinor: binding.max_cost_minor,
				priceMinor: binding.price_minor,
			});
		statements.push(
			db
				.prepare(
					`UPDATE supplier_bindings SET remote_status = ?,
					 last_error_code = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`,
				)
				.bind(
					confirmed ? "deleted" : "unknown",
					confirmed ? "supplier_sku_deleted" : "supplier_sku_missing_once",
					now,
					now,
					binding.id,
				),
		);
		if (confirmed)
			statements.push(
				db
					.prepare(
						`UPDATE product_sellable_items SET supplier_status = 'unavailable',
						 updated_at = ? WHERE id = ? AND fulfillment_source = 'supplier'`,
					)
					.bind(now, binding.sellable_item_id),
			);
	}
	for (let offset = 0; offset < statements.length; offset += 100)
		await db.batch(statements.slice(offset, offset + 100));
	return { delisted, boundKeys, costCapped };
}

/** One approval per SKU that just stopped because its cost rose past the cap. */
async function notifyCostCappedBindings(input: {
	db: D1Database;
	source: SupplierSourceIdentity;
	costCapped: CostCappedBinding[];
	now: number;
	fetcher?: typeof fetch;
}) {
	for (const item of input.costCapped) {
		const text = formatCostCapProposal(input.source.normalizedApiOrigin, item);
		const send =
			BigInt(item.costMinor) < BigInt(item.priceMinor)
				? proposeOwnerAction(input.db, {
						kind: "supplier_cost_cap",
						payload: costCapPayload(input.source, item),
						text,
						choices: ["✅ 按新进价恢复销售"],
						rejectLabel: "❌ 先不卖",
						fallback: "请到后台「供货」调整进价上限后恢复销售。",
						now: input.now,
						fetcher: input.fetcher,
					})
				: sendOwnerAlert(input.db, `${text}\n\n新进价不低于售价，请先调价。`, {
						fetcher: input.fetcher,
						topic: "restock",
					});
		await send.catch(() => undefined);
	}
}

/**
 * One message per sync. A delisted SKU with an affordable same-name
 * replacement gets its own approval buttons; the rest share a plain alert.
 */
async function notifyDelistedBindings(input: {
	db: D1Database;
	source: SupplierSourceIdentity;
	delisted: DelistedBinding[];
	products: SupplierProduct[];
	boundKeys: Set<string>;
	now: number;
	fetcher?: typeof fetch;
}) {
	const plain: DelistedBinding[] = [];
	for (const item of input.delisted) {
		const candidates = findRebindCandidates(
			item,
			input.products,
			input.boundKeys,
		);
		if (!candidates.length) {
			plain.push(item);
			continue;
		}
		const text = formatRebindProposal(
			input.source.normalizedApiOrigin,
			item,
			candidates,
		);
		if (
			!candidates.some((candidate) => affordable(candidate, item.maxCostMinor))
		) {
			await sendOwnerAlert(
				input.db,
				`${text}\n\n新商品进价超过上限，请先调价，再到后台「供货」切换来源。`,
				{ fetcher: input.fetcher, topic: "restock" },
			).catch(() => undefined);
			continue;
		}
		const choices = candidates.filter((candidate) =>
			affordable(candidate, item.maxCostMinor),
		);
		await proposeOwnerAction(input.db, {
			kind: "supplier_rebind",
			payload: rebindPayload(input.source, item, choices),
			text,
			choices: choices.map((_, index) => rebindChoiceLabel(choices, index)),
			rejectLabel: "❌ 不换",
			fallback: "请到后台「供货」切换来源后恢复销售。",
			now: input.now,
			fetcher: input.fetcher,
		}).catch(() => plain.push(item));
	}
	if (plain.length)
		await sendOwnerAlert(
			input.db,
			formatDelistedBindingsAlert(input.source.normalizedApiOrigin, plain),
			{ fetcher: input.fetcher, topic: "restock" },
		);
}

export function formatDelistedBindingsAlert(
	origin: string,
	delisted: DelistedBinding[],
) {
	return [
		`⚠️ 上游商品已下架（${new URL(origin).host}），以下规格已自动停售：`,
		...delisted.map(
			(item) =>
				`- ${item.productName}｜${item.sellableItemName}（上游：${item.upstreamProductName}，编号 ${item.upstreamProductId}）`,
		),
		"上游若换了新商品，请到后台「供货」切换来源后恢复销售。",
	].join("\n");
}

async function sourceAccounts(
	db: D1Database,
	source: SupplierSourceIdentity,
	now: number,
) {
	const result = await db
		.prepare(
			`SELECT * FROM supplier_accounts WHERE provider = ?
			 AND normalized_api_origin = ? AND protocol_version = ?
			 AND enabled = 1 AND (cooldown_until IS NULL OR cooldown_until <= ?)
			 ORDER BY CASE health_status WHEN 'healthy' THEN 0 WHEN 'unknown' THEN 1
			 ELSE 2 END, consecutive_failures, COALESCE(last_selected_at, 0), id`,
		)
		.bind(
			source.provider,
			source.normalizedApiOrigin,
			source.protocolVersion,
			now,
		)
		.all<SourceAccountRow>();
	return result.results;
}

async function sourceSyncTaskName(
	source: SupplierSourceIdentity,
	now: number,
	full = false,
) {
	const window = Math.floor(now / CATALOG_SYNC_WINDOW_MS);
	return `supplier.catalog.${await sourceDigest(source)}.${window}${full ? ".full" : ""}`;
}

async function sourceCatalogCacheKey(source: SupplierSourceIdentity) {
	return `supplier:catalog:v1:${await sourceDigest(source)}`;
}

async function sourceDigest(source: SupplierSourceIdentity) {
	const bytes = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				`${source.provider}\0${source.normalizedApiOrigin}\0${source.protocolVersion}`,
			),
		),
	);
	return Array.from(bytes.slice(0, 16), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function writeCachedSupplierCatalog(
	cache: KVNamespace | undefined,
	source: SupplierSourceIdentity,
	value: z.infer<typeof cachedCatalogSchema>,
) {
	if (!cache) return;
	try {
		await cache.put(
			await sourceCatalogCacheKey(source),
			JSON.stringify(cachedCatalogSchema.parse(value)),
			{ expirationTtl: CATALOG_CACHE_TTL_SECONDS },
		);
	} catch {
		// D1 binding state remains authoritative when optional KV is unavailable.
	}
}
