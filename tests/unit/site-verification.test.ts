import { describe, expect, it } from "vitest";
import { handleSiteVerificationRequest } from "#/features/seo/server/site-verification";

function kv(entries: Record<string, string>) {
	return {
		get: async (key: string) => entries[key] ?? null,
	} as unknown as KVNamespace;
}

const cache = kv({
	"site-verify:baidu_verify_codeva-abc123.html": "701715b1cb2f04b5",
});

describe("site verification files", () => {
	it("serves a stored file at the site root", async () => {
		const response = await handleSiteVerificationRequest(
			new Request("https://laoshirenvip.com/baidu_verify_codeva-abc123.html"),
			cache,
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toContain("text/html");
		expect(await response?.text()).toBe("701715b1cb2f04b5");
	});

	it("falls through for unknown files, nested paths and writes", async () => {
		for (const request of [
			new Request("https://laoshirenvip.com/missing-file.html"),
			new Request("https://laoshirenvip.com/a/baidu_verify_codeva-abc123.html"),
			new Request("https://laoshirenvip.com/products"),
			new Request("https://laoshirenvip.com/baidu_verify_codeva-abc123.html", {
				method: "POST",
			}),
		]) {
			expect(await handleSiteVerificationRequest(request, cache)).toBeNull();
		}
		expect(
			await handleSiteVerificationRequest(
				new Request("https://laoshirenvip.com/baidu_verify_codeva-abc123.html"),
				undefined,
			),
		).toBeNull();
	});
});
