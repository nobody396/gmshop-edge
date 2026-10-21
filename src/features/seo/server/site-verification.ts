const FILE_PATTERN = /^\/([A-Za-z0-9_-]{4,96}\.(?:html|txt))$/;
const KEY_PREFIX = "site-verify:";

/**
 * Serves search-platform ownership files (Baidu, Toutiao, …) at the site root.
 * The file body lives in KV under `site-verify:<file name>`, so a new platform
 * can be verified without a deploy. Paths with no KV entry fall through.
 */
export async function handleSiteVerificationRequest(
	request: Request,
	cache: KVNamespace | undefined,
): Promise<Response | null> {
	if (!cache) return null;
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	const fileName = FILE_PATTERN.exec(new URL(request.url).pathname)?.[1];
	if (!fileName) return null;
	const body = await cache.get(`${KEY_PREFIX}${fileName}`);
	if (body === null) return null;
	return new Response(request.method === "HEAD" ? null : body, {
		headers: {
			"content-type": fileName.endsWith(".html")
				? "text/html; charset=utf-8"
				: "text/plain; charset=utf-8",
			"cache-control": "public, max-age=3600",
		},
	});
}
