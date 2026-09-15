export function selectStorefrontProductRow(db: D1Database, productId: string) {
	return db
		.prepare(
			`SELECT p.id, p.name, p.description, p.product_type, p.sale_disabled,
			 p.cover_object_key, p.updated_at,
			 p.tag_names AS tags_json
			 FROM products p
			 WHERE p.id = ? AND p.status = 'active' LIMIT 1`,
		)
		.bind(productId)
		.first<Record<string, unknown>>();
}
