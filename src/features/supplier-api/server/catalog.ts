import { DomainError } from "#/lib/domain-error";

type ProductRow = {
	product_id: string;
	product_name: string;
	description: string | null;
	cover_object_key: string | null;
	tag_names: string;
	export_updated_at: number;
};

type SkuRow = {
	product_id: string;
	sku_id: string;
	sku_name: string;
	price_minor: string;
	stock_quantity: number;
};

const ELIGIBLE_PRODUCTS = `
	 SELECT product.id AS product_id, product.name AS product_name,
	 product.description, product.cover_object_key, product.tag_names, product.sort_order,
	 MAX(MAX(product.updated_at, item.updated_at, COALESCE(listing.updated_at, 0),
	  COALESCE((SELECT MAX(stock.updated_at) FROM stock_entries stock
	   WHERE stock.sellable_item_id = item.id), 0)))
	  AS export_updated_at
	 FROM products product
	 JOIN product_sellable_items item ON item.product_id = product.id
	 JOIN supplier_export_listings listing ON listing.sellable_item_id = item.id
	 WHERE listing.enabled = 1
	  AND product.status = 'active' AND product.product_type = 'stock'
	  AND item.enabled = 1 AND item.fulfillment_source = 'local'
	  AND item.currency = COALESCE((SELECT json_extract(value, '$') FROM system_settings
	   WHERE key = 'commerce.default_currency'), 'USD')
	  AND item.currency_decimals = COALESCE((SELECT CAST(json_extract(value, '$') AS INTEGER)
	   FROM system_settings WHERE key = 'commerce.currency_decimals'), 2)
	 GROUP BY product.id`;

const ELIGIBLE_SKUS = `
	SELECT item.product_id, item.id AS sku_id, item.name AS sku_name,
	 COALESCE(listing.price_minor, item.price_minor) AS price_minor,
	 (SELECT COUNT(*) FROM stock_entries stock WHERE stock.sellable_item_id = item.id
	  AND stock.status = 'available') AS stock_quantity
	 FROM product_sellable_items item
	 JOIN supplier_export_listings listing ON listing.sellable_item_id = item.id
	 JOIN products product ON product.id = item.product_id
	 WHERE listing.enabled = 1
	  AND product.status = 'active' AND product.product_type = 'stock'
	  AND item.enabled = 1 AND item.fulfillment_source = 'local'
	  AND item.currency = COALESCE((SELECT json_extract(value, '$') FROM system_settings
	   WHERE key = 'commerce.default_currency'), 'USD')
	  AND item.currency_decimals = COALESCE((SELECT CAST(json_extract(value, '$') AS INTEGER)
	   FROM system_settings WHERE key = 'commerce.currency_decimals'), 2)`;

export async function listSupplierCatalog(
	db: D1Database,
	input: { page: number; pageSize: number; updatedAfter?: string },
) {
	const updatedAfter = input.updatedAfter ? Date.parse(input.updatedAfter) : 0;
	const offset = (input.page - 1) * input.pageSize;
	const [countResult, productResult] = await db.batch([
		db
			.prepare(
				`WITH eligible_products AS (${ELIGIBLE_PRODUCTS})
				 SELECT COUNT(*) AS total FROM eligible_products
				 WHERE export_updated_at >= ?`,
			)
			.bind(updatedAfter),
		db
			.prepare(
				`WITH eligible_products AS (${ELIGIBLE_PRODUCTS})
				 SELECT product_id, product_name, description, cover_object_key, tag_names, export_updated_at
				 FROM eligible_products WHERE export_updated_at >= ?
				 ORDER BY sort_order, product_id LIMIT ? OFFSET ?`,
			)
			.bind(updatedAfter, input.pageSize, offset),
	]);
	const products = (productResult?.results ?? []) as ProductRow[];
	const skus = await loadProductSkus(
		db,
		products.map((product) => product.product_id),
	);
	return {
		total: Number(
			(countResult?.results?.[0] as { total?: number } | undefined)?.total ?? 0,
		),
		items: assembleProducts(products, skus),
	};
}

export async function getSupplierProduct(db: D1Database, productId: string) {
	const product = await db
		.prepare(
			`WITH eligible_products AS (${ELIGIBLE_PRODUCTS})
			 SELECT product_id, product_name, description, cover_object_key, tag_names, export_updated_at
			 FROM eligible_products WHERE product_id = ? LIMIT 1`,
		)
		.bind(productId)
		.first<ProductRow>();
	if (!product)
		throw new DomainError(
			"supplier_product_not_found",
			404,
			"Product not found",
		);
	const skus = await loadProductSkus(db, [productId]);
	return { product: assembleProducts([product], skus)[0] };
}

async function loadProductSkus(db: D1Database, productIds: string[]) {
	if (productIds.length === 0) return [];
	const placeholders = productIds.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`${ELIGIBLE_SKUS}
			 AND item.product_id IN (${placeholders})
			 ORDER BY product.sort_order, product.id, item.sort_order, item.id`,
		)
		.bind(...productIds)
		.all<SkuRow>();
	return result.results;
}

function assembleProducts(products: ProductRow[], skus: SkuRow[]) {
	const skusByProduct = new Map<string, SkuRow[]>();
	for (const sku of skus) {
		const productSkus = skusByProduct.get(sku.product_id) ?? [];
		productSkus.push(sku);
		skusByProduct.set(sku.product_id, productSkus);
	}
	return products.map((product) => ({
		id: product.product_id,
		name: product.product_name,
		description: product.description ?? "",
		image_urls: product.cover_object_key
			? [`/api/shop/products/${encodeURIComponent(product.product_id)}/cover`]
			: [],
		category_names: JSON.parse(product.tag_names) as string[],
		active: true,
		updated_at: new Date(product.export_updated_at).toISOString(),
		skus: (skusByProduct.get(product.product_id) ?? []).map((sku) => ({
			id: sku.sku_id,
			name: sku.sku_name,
			cost_minor: sku.price_minor,
			stock_quantity: Number(sku.stock_quantity),
			active: Number(sku.stock_quantity) > 0,
		})),
	}));
}
