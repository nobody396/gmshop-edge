import { describe, expect, it } from "vitest";
import { checkIp, maskIp } from "#/features/ip-check/check";
import { handleIpCheck } from "#/features/ip-check/server/lookup";

function request(
	cf: Record<string, unknown> = {},
	ip = "203.0.113.10",
	url = "https://shop.example/api/ip-check",
) {
	const req = new Request(url, {
		headers: { "cf-connecting-ip": ip, "x-forwarded-for": "8.8.8.8" },
	});
	Object.defineProperty(req, "cf", {
		value: {
			country: "US",
			asn: 12345,
			asOrganization: "Example Network",
			...cf,
		},
	});
	return req;
}
describe("owned IP check and ablations", () => {
	it("does not turn absence of hosting signals into a residential or safe verdict", () => {
		expect(checkIp(request(), "cloudflare")).toMatchObject({
			status: "limited",
			hosting: "unknown",
			region: "listed",
		});
	});
	it.each([
		16509, 8075, 14061, 45102,
	])("detects known hosting ASN %s", (asn) => {
		expect(checkIp(request({ asn }), "cloudflare").status).toBe("hosting");
	});
	it("keeps organization heuristic after ASN removal", () => {
		expect(
			checkIp(
				request({ asn: 12345, asOrganization: "Example Hosting" }),
				"cloudflare",
			).hosting,
		).toBe("suspected");
	});
	it("keeps ASN heuristic after name removal", () => {
		expect(
			checkIp(
				request({ asn: 8075, asOrganization: "Example Network" }),
				"cloudflare",
			).hosting,
		).toBe("suspected");
	});
	it.each([
		"CN",
		"HK",
		"RU",
	])("region %s takes priority over hosting", (country) => {
		expect(
			checkIp(request({ country, asn: 8075 }), "cloudflare"),
		).toMatchObject({ status: "region", region: "unlisted" });
	});
	it("does not blanket-approve Ukraine", () =>
		expect(checkIp(request({ country: "UA" }), "cloudflare").region).toBe(
			"review",
		));
	it.each([
		"XX",
		"T1",
		"",
		undefined,
	])("missing or special country %s stays incomplete", (country) => {
		expect(checkIp(request({ country }), "cloudflare").status).toBe(
			"incomplete",
		);
	});
	it("removing edge metadata does not trust user-supplied forwarding headers", () => {
		expect(
			checkIp(
				new Request("https://shop.example/api/ip-check", {
					headers: { "cf-connecting-ip": "8.8.8.8" },
				}),
				"cloudflare",
			),
		).toMatchObject({ ip: null, status: "incomplete" });
	});
	it("Bun never treats spoofable Cloudflare headers or metadata as proof", () => {
		expect(checkIp(request(), "bun")).toMatchObject({
			ip: null,
			country: null,
			status: "incomplete",
		});
	});
	it("invalid IP or incomplete ASN cannot produce a completed result", () => {
		expect(checkIp(request({}, "not-an-ip"), "cloudflare").status).toBe(
			"incomplete",
		);
		expect(checkIp(request({ asn: undefined }), "cloudflare").status).toBe(
			"incomplete",
		);
	});
	it("supports IPv6 while masking both address families", () => {
		expect(checkIp(request({}, "2001:db8::1"), "cloudflare").ip).toBe(
			"2001:db8::1",
		);
		expect(maskIp("2001:db8::1")).toBe("2001:••••:••••");
		expect(maskIp("203.0.113.10")).toBe("203.•••.•••.10");
		expect(maskIp(null)).toBe("—");
	});

	it("is no-store and rejects private queries and writes", async () => {
		const response = await handleIpCheck(request(), { runtime: "cloudflare" });
		expect(response?.headers.get("cache-control")).toBe("private, no-store");
		expect(response?.headers.get("cdn-cache-control")).toBe("no-store");
		expect(await response?.json()).toMatchObject({ ip: "203.0.113.10" });
		expect(
			(
				await handleIpCheck(
					request(
						{},
						undefined,
						"https://shop.example/api/ip-check?ip=127.0.0.1",
					),
					{ runtime: "cloudflare" },
				)
			)?.status,
		).toBe(400);
		expect(
			(
				await handleIpCheck(
					new Request("https://shop.example/api/ip-check", { method: "POST" }),
					{ runtime: "cloudflare" },
				)
			)?.status,
		).toBe(405);
		expect(
			await handleIpCheck(new Request("https://shop.example/other"), {
				runtime: "cloudflare",
			}),
		).toBeNull();
	});
});
it("local Wrangler metadata is never presented as the visitor's live result", () => {
	expect(
		checkIp(
			request({}, "127.0.0.1", "http://127.0.0.1:3016/api/ip-check"),
			"cloudflare",
		),
	).toMatchObject({ ip: null, country: null, status: "incomplete" });
});
it("masks browser WebRTC IPv6 addresses that include brackets", () => {
	expect(maskIp("[2001:db8::1]")).toBe("2001:••••:••••");
});
