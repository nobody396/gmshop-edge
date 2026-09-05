const accelerationDomainHeader = "tencent-acceleration-domain";

export function resolveRequestAuthBaseUrl(
	request: Request,
	fallback: string,
	trustedOrigins: readonly string[],
) {
	const trusted = new Set(trustedOrigins.flatMap(normalizeOrigin));
	const candidates = [
		accelerationOrigin(request),
		new URL(request.url).origin,
		fallback,
	];
	for (const candidate of candidates) {
		const [origin] = normalizeOrigin(candidate);
		if (origin && trusted.has(origin)) return origin;
	}
	return fallback;
}

function accelerationOrigin(request: Request) {
	const host = request.headers.get(accelerationDomainHeader)?.trim();
	if (!host) return null;
	const protocol = request.headers
		.get("x-forwarded-proto")
		?.split(",", 1)[0]
		?.trim()
		.toLowerCase();
	if (protocol !== "https") return null;
	return `https://${host}`;
}

function normalizeOrigin(value: string | null) {
	if (!value) return [];
	try {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol)) return [];
		if (
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			return [];
		return [url.origin];
	} catch {
		return [];
	}
}
