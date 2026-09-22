import { describe, expect, it } from "vitest";
import { authenticateGmshopMirror } from "#/server/middleware/gmshop-mirror";

const secret = "a".repeat(64);
function request(headers: Record<string, string> = {}) {
	return new Request(
		"https://gmshop-edge.laoshirenai.workers.dev/api/auth/sign-in/email",
		{
			method: "POST",
			headers: { "cf-connecting-ip": "43.1.2.3", ...headers },
			body: '{"unchanged":true}',
		},
	);
}
describe("authenticated GMShop mirrors", () => {
	it.each([
		"shop.laoshirenai.com",
		"cn.laoshirenvip.com",
	])("preserves body and accepts only verified %s source", async (marker) => {
		const result = await authenticateGmshopMirror(
			request({
				"tencent-acceleration-domain": marker,
				"x-gmshop-origin-verify": secret,
				"eo-connecting-ip": "198.51.100.9",
			}),
			secret,
		);
		expect(result).toBeInstanceOf(Request);
		if (!(result instanceof Request)) throw new Error("expected request");
		expect(result.headers.get("cf-connecting-ip")).toBe("198.51.100.9");
		expect(result.headers.has("x-gmshop-origin-verify")).toBe(false);
		expect(result.method).toBe("POST");
		expect(await result.text()).toBe('{"unchanged":true}');
	});
	it("does not trust forged EO headers on normal Cloudflare traffic", async () => {
		const result = await authenticateGmshopMirror(
			request({
				"eo-connecting-ip": "192.0.2.1",
				"x-forwarded-for": "192.0.2.2",
				"x-gmshop-origin-verify": "do-not-log",
			}),
			secret,
		);
		if (!(result instanceof Request)) throw new Error("expected request");
		expect(result.headers.get("cf-connecting-ip")).toBe("43.1.2.3");
		expect(result.headers.has("x-gmshop-origin-verify")).toBe(false);
	});
	it.each([
		undefined,
		"wrong",
	])("rejects unverified mirror proof %s", async (proof) => {
		const req = request({
			"tencent-acceleration-domain": "shop.laoshirenai.com",
			"eo-connecting-ip": "192.0.2.1",
			...(proof ? { "x-gmshop-origin-verify": proof } : {}),
		});
		expect(
			((await authenticateGmshopMirror(req, secret)) as Response).status,
		).toBe(403);
	});
	it.each([
		"",
		"192.0.2.1, 192.0.2.2",
		"unknown",
	])("rejects invalid or multi-valued EO address %s", async (ip) => {
		expect(
			(
				(await authenticateGmshopMirror(
					request({
						"tencent-acceleration-domain": "shop.laoshirenai.com",
						"x-gmshop-origin-verify": secret,
						"eo-connecting-ip": ip,
					}),
					secret,
				)) as Response
			).status,
		).toBe(403);
	});
	it("supports IPv6 without weakening the proof", async () => {
		const result = await authenticateGmshopMirror(
			request({
				"tencent-acceleration-domain": "shop.laoshirenai.com",
				"x-gmshop-origin-verify": secret,
				"eo-connecting-ip": "2001:db8::1",
			}),
			secret,
		);
		expect(result).toBeInstanceOf(Request);
		expect(result.headers.get("cf-connecting-ip")).toBe("2001:db8::1");
	});
	it("fails closed for missing runtime configuration only on mirrors", async () => {
		expect(
			(
				(await authenticateGmshopMirror(
					request({ "tencent-acceleration-domain": "shop.laoshirenai.com" }),
					undefined,
				)) as Response
			).status,
		).toBe(503);
		expect(await authenticateGmshopMirror(request(), undefined)).toBeInstanceOf(
			Request,
		);
	});
});
