export async function productCoverResponse(
	request: Request,
	productId: string,
	db: D1Database,
	bucket: R2Bucket | undefined,
) {
	const product = await db
		.prepare(
			"SELECT cover_object_key FROM products WHERE id = ? AND status = 'active' LIMIT 1",
		)
		.bind(productId)
		.first<{ cover_object_key: string | null }>();
	if (!product?.cover_object_key || !bucket)
		return new Response("Not found", { status: 404 });
	// Banner covers read badly at icon size; a square thumbnail, when uploaded, serves those slots.
	const thumb = new URL(request.url).searchParams.has("thumb")
		? await bucket.get(`product-thumbs/${productId}.webp`, {
				onlyIf: request.headers,
			})
		: null;
	const object =
		thumb ??
		(await bucket.get(product.cover_object_key, {
			onlyIf: request.headers,
		}));
	if (!object) return new Response("Not found", { status: 404 });
	const headers = new Headers({
		"Cache-Control": "public, max-age=31536000, immutable",
		"X-Content-Type-Options": "nosniff",
		ETag: object.httpEtag,
	});
	object.writeHttpMetadata(headers);
	if (!("body" in object)) return new Response(null, { status: 304, headers });
	return new Response((object as R2ObjectBody).body, { headers });
}
