import { z } from "zod";

const mirrors = new Set(["shop.laoshirenai.com", "cn.laoshirenvip.com"]);
const address = z.union([z.ipv4(), z.ipv6()]);
const encoder = new TextEncoder();

// Only our authenticated EdgeOne mirror requests may replace Cloudflare's peer
// address. Public marker/EO/forwarding headers alone never establish trust.
export async function authenticateGmshopMirror(
	request: Request,
	secret: string | undefined,
): Promise<Request | Response> {
	const marker = request.headers.get("tencent-acceleration-domain");
	const provided = request.headers.get("x-gmshop-origin-verify");
	if (!marker) {
		if (!provided) return request;
		const headers = new Headers(request.headers);
		headers.delete("x-gmshop-origin-verify");
		return new Request(request, { headers });
	}
	if (!mirrors.has(marker)) return new Response("Forbidden", { status: 403 });
	if (!secret || secret.length < 32)
		return new Response("Service Unavailable", { status: 503 });
	if (!provided || provided.length > 512)
		return new Response("Forbidden", { status: 403 });
	const [expectedDigest, suppliedDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(secret)),
		crypto.subtle.digest("SHA-256", encoder.encode(provided)),
	]);
	const expected = new Uint8Array(expectedDigest);
	const supplied = new Uint8Array(suppliedDigest);
	let difference = 0;
	for (let i = 0; i < expected.length; i++)
		difference |= (expected[i] ?? 0) ^ (supplied[i] ?? 0);
	const ip = request.headers.get("eo-connecting-ip");
	if (difference || !address.safeParse(ip).success)
		return new Response("Forbidden", { status: 403 });
	const headers = new Headers(request.headers);
	headers.set("cf-connecting-ip", ip ?? "");
	headers.delete("x-gmshop-origin-verify");
	return new Request(request, { headers });
}
