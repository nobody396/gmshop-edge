const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

/**
 * Serves the public IndexNow ownership file at exactly `/<INDEXNOW_KEY>.txt`.
 * Every other path falls through to the app unchanged.
 */
export function handleIndexNowKeyRequest(
	request: Request,
	key: string | undefined,
): Response | null {
	if (!key || !KEY_PATTERN.test(key)) return null;
	if (new URL(request.url).pathname !== `/${key}.txt`) return null;
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
	return new Response(request.method === "HEAD" ? null : key, {
		headers: {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "public, max-age=86400",
		},
	});
}
