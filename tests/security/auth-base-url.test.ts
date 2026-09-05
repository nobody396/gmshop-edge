import { describe, expect, it } from "vitest";
import { resolveRequestAuthBaseUrl } from "#/features/auth/server/auth-base-url";

const trustedOrigins = [
	"https://laoshirenvip.com",
	"https://shop.laoshirenai.com",
	"https://gmshop-edge.laoshirenai.workers.dev",
];

describe("request authentication base URL", () => {
	it("keeps direct authentication on the requested trusted host", () => {
		expect(
			resolveRequestAuthBaseUrl(
				new Request("https://laoshirenvip.com/api/auth/sign-in/social", {
					headers: { origin: "https://laoshirenvip.com" },
				}),
				"https://laoshirenvip.com",
				trustedOrigins,
			),
		).toBe("https://laoshirenvip.com");
	});

	it("keeps browser authentication on the trusted acceleration domain", () => {
		expect(
			resolveRequestAuthBaseUrl(
				new Request(
					"https://gmshop-edge.laoshirenai.workers.dev/api/auth/sign-in/social",
					{
						headers: {
							"tencent-acceleration-domain": "shop.laoshirenai.com",
							"x-forwarded-proto": "https",
						},
					},
				),
				"https://laoshirenvip.com",
				trustedOrigins,
			),
		).toBe("https://shop.laoshirenai.com");
	});

	it("does not trust a browser Origin without the acceleration header", () => {
		expect(
			resolveRequestAuthBaseUrl(
				new Request(
					"https://gmshop-edge.laoshirenai.workers.dev/api/auth/sign-in/social",
					{ headers: { origin: "https://shop.laoshirenai.com" } },
				),
				"https://laoshirenvip.com",
				trustedOrigins,
			),
		).toBe("https://gmshop-edge.laoshirenai.workers.dev");
	});

	it("restores the acceleration domain for an OAuth callback without Origin", () => {
		expect(
			resolveRequestAuthBaseUrl(
				new Request(
					"https://gmshop-edge.laoshirenai.workers.dev/api/auth/callback/google",
					{
						headers: {
							"tencent-acceleration-domain": "shop.laoshirenai.com",
							"x-forwarded-proto": "https",
						},
					},
				),
				"https://laoshirenvip.com",
				trustedOrigins,
			),
		).toBe("https://shop.laoshirenai.com");
	});

	it("ignores untrusted or insecure forwarded hosts", () => {
		for (const headers of [
			{
				"tencent-acceleration-domain": "evil.example",
				"x-forwarded-proto": "https",
			},
			{
				"tencent-acceleration-domain": "shop.laoshirenai.com",
				"x-forwarded-proto": "http",
			},
		]) {
			expect(
				resolveRequestAuthBaseUrl(
					new Request(
						"https://gmshop-edge.laoshirenai.workers.dev/api/auth/callback/google",
						{ headers },
					),
					"https://laoshirenvip.com",
					trustedOrigins,
				),
			).toBe("https://gmshop-edge.laoshirenai.workers.dev");
		}
	});
});
