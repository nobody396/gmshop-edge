import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { z } from "zod";
import {
	cartMutationSchema,
	cartRemoveSchema,
	cartSyncSchema,
	storedCartItemsSchema,
} from "#/features/storefront/schema";
import { DomainError } from "#/lib/domain-error";
import { getDb } from "#/server/db.server";
import { resolveStoreAccount } from "./account";
import { storefrontStockExpression } from "./stock-availability";

const CART_TTL_MS = 30 * 86_400_000;
const CART_ITEM_LIMIT = 50;

type StoredCartItem = z.infer<typeof storedCartItemsSchema>[number];
type StoredCart = {
	id: string;
	version: number;
	items: StoredCartItem[];
};

export const getStoreCartFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request);
		if (!account)
			return { authenticated: false as const, version: null, items: [] };
		return presentCart(db, account.user.id);
	},
);

export const previewStoreCartFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof cartSyncSchema>) =>
		cartSyncSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const db = getDb().$client;
		const results = data.items.length
			? await db.batch(
					data.items.map((item) =>
						db
							.prepare(
								`SELECT s.id AS sellable_item_id, s.name AS sellable_item_name, s.price_minor, s.currency,
						 s.currency_decimals, s.minimum_quantity,
						 s.maximum_quantity,
						 p.id AS product_id, p.name AS product_name,
						 s.id AS delivery_component_id, p.product_type AS delivery_type,
						 p.status, p.sale_disabled AS product_sale_disabled,
						 s.sale_disabled AS sellable_item_sale_disabled,
						 p.cover_object_key, p.updated_at,
						 ${storefrontStockExpression("p", "s")} AS available_stock
						 FROM product_sellable_items s JOIN products p ON p.id = s.product_id
						 WHERE s.id = ? AND s.enabled = 1 LIMIT 1`,
							)
							.bind(item.sellableItemId),
					),
				)
			: [];
		return {
			authenticated: false as const,
			version: null,
			items: data.items.map((item, index) => {
				const row = results[index]?.results[0] as
					| Record<string, unknown>
					| undefined;
				if (!row)
					return {
						sellableItemId: item.sellableItemId,
						quantity: item.quantity,
						productName: item.sellableItemId,
						sellableItemName: "",
						issues: ["unavailable"],
					};
				const stock = Number(row.available_stock);
				const maximum = Number(row.maximum_quantity);
				const issues: string[] = [];
				if (String(row.status) !== "active") issues.push("unavailable");
				if (row.product_sale_disabled || row.sellable_item_sale_disabled)
					issues.push("sale_disabled");
				if (stock === 0) issues.push("sold_out");
				if (
					item.quantity < Number(row.minimum_quantity) ||
					item.quantity > maximum ||
					(stock >= 0 && item.quantity > stock)
				)
					issues.push("quantity_unavailable");
				return {
					sellableItemId: item.sellableItemId,
					quantity: item.quantity,
					priceMinorSnapshot: String(row.price_minor),
					priceMinor: String(row.price_minor),
					currency: String(row.currency),
					currencyDecimals: Number(row.currency_decimals),
					minimumQuantity: Number(row.minimum_quantity),
					maximumQuantity: maximum,
					availableStock: stock,
					productId: String(row.product_id),
					productName: String(row.product_name),
					deliveryComponentId: String(row.delivery_component_id),
					deliveryType: String(row.delivery_type),
					sellableItemName: String(row.sellable_item_name),
					coverUrl: row.cover_object_key
						? `/api/shop/products/${row.product_id}/cover?v=${row.updated_at}`
						: null,
					issues,
				};
			}),
		};
	});

export const syncStoreCartFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof cartSyncSchema>) =>
		cartSyncSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request);
		if (!account)
			return { authenticated: false as const, version: null, items: [] };
		const normalized = new Map<string, number>();
		for (const item of data.items)
			normalized.set(
				item.sellableItemId,
				Math.min(
					1_000,
					(normalized.get(item.sellableItemId) ?? 0) + item.quantity,
				),
			);
		const cart = await ensureCart(db, account.user.id);
		if (data.expectedVersion != null && data.expectedVersion !== cart.version)
			throw new DomainError(
				"cart_version_conflict",
				409,
				"Cart changed elsewhere",
			);
		for (const row of cart.items)
			normalized.set(
				row.sellableItemId,
				Math.min(
					1_000,
					(normalized.get(row.sellableItemId) ?? 0) + row.quantity,
				),
			);
		assertCartItemLimit(normalized.size);
		await replaceCartItems(db, cart, normalized);
		return presentCart(db, account.user.id);
	});

export const setStoreCartItemFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof cartMutationSchema>) =>
		cartMutationSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db, userId } = await requiredCartContext();
		const cart = await ensureCart(db, userId);
		assertCartVersion(cart.version, data.expectedVersion);
		await setCartItem(db, cart, data.sellableItemId, data.quantity);
		return presentCart(db, userId);
	});

export const removeStoreCartItemFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof cartRemoveSchema>) =>
		cartRemoveSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const { db, userId } = await requiredCartContext();
		const cart = await ensureCart(db, userId);
		assertCartVersion(cart.version, data.expectedVersion);
		await updateCartItems(
			db,
			cart,
			cart.items.filter((item) => item.sellableItemId !== data.sellableItemId),
		);
		return presentCart(db, userId);
	});

export const clearStoreCartFn = createServerFn({ method: "POST" })
	.validator((input: { expectedVersion: number }) =>
		cartRemoveSchema.pick({ expectedVersion: true }).parse(input),
	)
	.handler(async ({ data }) => {
		const { db, userId } = await requiredCartContext();
		const cart = await ensureCart(db, userId);
		assertCartVersion(cart.version, data.expectedVersion);
		await updateCartItems(db, cart, []);
		return presentCart(db, userId);
	});

async function requiredCartContext() {
	const request = getRequest();
	const db = getDb(request).$client;
	const account = await resolveStoreAccount(db, request, {
		required: true,
	});
	if (!account)
		throw new DomainError("authentication_required", 401, "Sign in required");
	return { db, userId: account.user.id };
}

export async function setUserCartItem(
	db: D1Database,
	userId: string,
	sellableItemId: string,
	quantity: number,
) {
	const cart = await ensureCart(db, userId);
	await setCartItem(db, cart, sellableItemId, quantity);
}

export async function removeUserCartItems(
	db: D1Database,
	userId: string,
	sellableItemIds: Iterable<string>,
) {
	const removed = new Set(sellableItemIds);
	if (removed.size === 0) return;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const cart = await ensureCart(db, userId);
		const items = cart.items.filter(
			(item) => !removed.has(item.sellableItemId),
		);
		if (items.length === cart.items.length) return;
		try {
			await updateCartItems(db, cart, items);
			return;
		} catch (error) {
			if (
				!(error instanceof DomainError) ||
				error.code !== "cart_version_conflict"
			)
				throw error;
		}
	}
	throw new DomainError("cart_version_conflict", 409, "Cart changed elsewhere");
}

export async function removeSellableItemsFromAllCarts(
	db: D1Database,
	sellableItemIds: Iterable<string>,
) {
	const removed = new Set(sellableItemIds);
	if (removed.size === 0) return;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const rows = await db
			.prepare(
				`SELECT id, items_json, version FROM shopping_carts
				 WHERE json_valid(items_json) AND EXISTS (
				  SELECT 1 FROM json_each(items_json)
				  WHERE json_extract(value, '$.sellableItemId') IN (${[...removed].map(() => "?").join(",")})
				 )`,
			)
			.bind(...removed)
			.all<{ id: string; items_json: string; version: number }>();
		if (rows.results.length === 0) return;
		for (const row of rows.results) {
			const items = parseStoredCartItems(row.items_json).filter(
				(item) => !removed.has(item.sellableItemId),
			);
			try {
				await updateCartItems(
					db,
					{ id: row.id, version: Number(row.version) },
					items,
				);
			} catch (error) {
				if (
					!(error instanceof DomainError) ||
					error.code !== "cart_version_conflict"
				)
					throw error;
			}
		}
	}
	throw new DomainError("cart_version_conflict", 409, "Cart changed elsewhere");
}

async function ensureCart(db: D1Database, userId: string) {
	const now = Date.now();
	const existing = await db
		.prepare(
			"SELECT id, items_json, version, expires_at FROM shopping_carts WHERE user_id = ? LIMIT 1",
		)
		.bind(userId)
		.first<{
			id: string;
			items_json: string;
			version: number;
			expires_at: number;
		}>();
	if (existing) {
		const cart = {
			id: existing.id,
			version: Number(existing.version),
			items: parseStoredCartItems(existing.items_json),
		};
		if (Number(existing.expires_at) > now) return cart;
		const reset = await updateCartItems(db, cart, [], now);
		return { ...cart, version: cart.version + 1, items: reset };
	}
	const id = crypto.randomUUID();
	await db
		.prepare(
			`INSERT OR IGNORE INTO shopping_carts
			 (id, user_id, items_json, version, expires_at, created_at, updated_at)
			 VALUES (?, ?, '[]', 1, ?, ?, ?)`,
		)
		.bind(id, userId, now + CART_TTL_MS, now, now)
		.run();
	const created = await db
		.prepare(
			"SELECT id, items_json, version FROM shopping_carts WHERE user_id = ? LIMIT 1",
		)
		.bind(userId)
		.first<{ id: string; items_json: string; version: number }>();
	return created
		? {
				id: created.id,
				version: Number(created.version),
				items: parseStoredCartItems(created.items_json),
			}
		: { id, version: 1, items: [] };
}

export async function replaceCartItems(
	db: D1Database,
	cart: StoredCart,
	items: Map<string, number>,
) {
	assertCartItemLimit(items.size);
	const sellableItems = await Promise.all(
		[...items].map(async ([sellableItemId, quantity]) => {
			const sellableItem = await loadStoredCartSellableItem(db, sellableItemId);
			return sellableItem
				? {
						sellableItemId,
						quantity: Math.max(
							sellableItem.minimumQuantity,
							Math.min(quantity, sellableItem.maximumQuantity),
						),
						sellableItem,
					}
				: null;
		}),
	);
	await updateCartItems(
		db,
		cart,
		sellableItems.flatMap((item) =>
			item
				? [
						{
							sellableItemId: item.sellableItemId,
							quantity: item.quantity,
						},
					]
				: [],
		),
	);
}

async function setCartItem(
	db: D1Database,
	cart: StoredCart,
	sellableItemId: string,
	requestedQuantity: number,
) {
	const sellableItem = await loadCartSellableItem(db, sellableItemId);
	if (!sellableItem)
		throw new DomainError(
			"cart_item_unavailable",
			409,
			"Product is unavailable",
		);
	const quantity = Math.max(
		sellableItem.minimumQuantity,
		Math.min(requestedQuantity, sellableItem.maximumQuantity),
	);
	const existing = cart.items.findIndex(
		(item) => item.sellableItemId === sellableItemId,
	);
	if (existing < 0) assertCartItemLimit(cart.items.length + 1);
	const items =
		existing < 0
			? [...cart.items, { sellableItemId, quantity }]
			: cart.items.map((item, index) =>
					index === existing ? { sellableItemId, quantity } : item,
				);
	await updateCartItems(db, cart, items);
}

async function updateCartItems(
	db: D1Database,
	cart: Pick<StoredCart, "id" | "version">,
	items: StoredCartItem[],
	now = Date.now(),
) {
	const validated = storedCartItemsSchema.parse(items);
	const result = await db
		.prepare(
			`UPDATE shopping_carts
			 SET items_json = ?, version = version + 1, expires_at = ?, updated_at = ?
			 WHERE id = ? AND version = ?`,
		)
		.bind(
			JSON.stringify(validated),
			now + CART_TTL_MS,
			now,
			cart.id,
			cart.version,
		)
		.run();
	if (Number(result.meta.changes ?? 0) !== 1)
		throw new DomainError(
			"cart_version_conflict",
			409,
			"Cart changed elsewhere",
		);
	return validated;
}

function parseStoredCartItems(raw: string) {
	try {
		return storedCartItemsSchema.parse(JSON.parse(raw));
	} catch {
		throw new DomainError(
			"cart_data_invalid",
			500,
			"Stored cart data is invalid",
		);
	}
}

function assertCartItemLimit(size: number) {
	if (size > CART_ITEM_LIMIT)
		throw new DomainError(
			"cart_item_limit_exceeded",
			409,
			"A cart can contain at most 50 items",
		);
}

function assertCartVersion(actual: number, expected: number | null) {
	if (expected != null && actual !== expected)
		throw new DomainError(
			"cart_version_conflict",
			409,
			"Cart changed elsewhere",
		);
}

export async function loadCartSellableItem(
	db: D1Database,
	sellableItemId: string,
) {
	const row = await db
		.prepare(
			`SELECT s.price_minor, s.minimum_quantity, s.maximum_quantity
			 FROM product_sellable_items s
			 JOIN products p ON p.id = s.product_id
			 WHERE s.id = ? AND s.enabled = 1 AND s.sale_disabled = 0
			  AND p.status = 'active' AND p.sale_disabled = 0 LIMIT 1`,
		)
		.bind(sellableItemId)
		.first<{
			price_minor: string;
			minimum_quantity: number;
			maximum_quantity: number;
		}>();
	return row
		? {
				priceMinor: row.price_minor,
				minimumQuantity: Number(row.minimum_quantity),
				maximumQuantity: Number(row.maximum_quantity),
			}
		: null;
}

async function loadStoredCartSellableItem(
	db: D1Database,
	sellableItemId: string,
) {
	const row = await db
		.prepare(
			"SELECT price_minor, minimum_quantity, maximum_quantity FROM product_sellable_items WHERE id = ? LIMIT 1",
		)
		.bind(sellableItemId)
		.first<{
			price_minor: string;
			minimum_quantity: number;
			maximum_quantity: number;
		}>();
	return row
		? {
				priceMinor: row.price_minor,
				minimumQuantity: Number(row.minimum_quantity),
				maximumQuantity: Number(row.maximum_quantity),
			}
		: null;
}

export async function presentCart(db: D1Database, userId: string) {
	const cart = await ensureCart(db, userId);
	const results = cart.items.length
		? await db.batch(
				cart.items.map((item) =>
					db
						.prepare(
							`SELECT s.id AS sellable_item_id, s.name AS sellable_item_name,
					 s.price_minor, s.currency, s.currency_decimals, s.minimum_quantity,
					 s.maximum_quantity, s.enabled AS sellable_item_enabled,
					 p.id AS product_id, p.name AS product_name,
					 s.id AS delivery_component_id, p.product_type AS delivery_type,
					 p.status, p.sale_disabled AS product_sale_disabled,
					 s.sale_disabled AS sellable_item_sale_disabled,
					 p.cover_object_key, p.updated_at,
					 ${storefrontStockExpression("p", "s")} AS available_stock
					 FROM product_sellable_items s JOIN products p ON p.id = s.product_id
					 WHERE s.id = ? LIMIT 1`,
						)
						.bind(item.sellableItemId),
				),
			)
		: [];
	return {
		authenticated: true as const,
		version: cart.version,
		items: cart.items.map((item, index) => {
			const row = results[index]?.results[0] as
				| Record<string, unknown>
				| undefined;
			if (!row)
				return {
					sellableItemId: item.sellableItemId,
					quantity: item.quantity,
					productName: item.sellableItemId,
					sellableItemName: "",
					issues: ["unavailable"],
				};
			const stock = Number(row.available_stock);
			const maximum = Number(row.maximum_quantity);
			const issues: string[] = [];
			if (String(row.status) !== "active" || !row.sellable_item_enabled)
				issues.push("unavailable");
			if (row.product_sale_disabled || row.sellable_item_sale_disabled)
				issues.push("sale_disabled");
			if (stock === 0) issues.push("sold_out");
			if (
				item.quantity < Number(row.minimum_quantity) ||
				item.quantity > maximum ||
				(stock >= 0 && item.quantity > stock)
			)
				issues.push("quantity_unavailable");
			return {
				sellableItemId: item.sellableItemId,
				quantity: item.quantity,
				priceMinorSnapshot: String(row.price_minor),
				priceMinor: String(row.price_minor),
				currency: String(row.currency),
				currencyDecimals: Number(row.currency_decimals),
				minimumQuantity: Number(row.minimum_quantity),
				maximumQuantity: maximum,
				availableStock: stock,
				productId: String(row.product_id),
				productName: String(row.product_name),
				deliveryComponentId: String(row.delivery_component_id),
				deliveryType: String(row.delivery_type),
				sellableItemName: String(row.sellable_item_name),
				coverUrl: row.cover_object_key
					? `/api/shop/products/${row.product_id}/cover?v=${row.updated_at}`
					: null,
				issues,
			};
		}),
	};
}
