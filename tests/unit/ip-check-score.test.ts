import { describe, expect, it } from "vitest";
import { ipCheckSchema } from "#/features/ip-check/check";
import { abusePoints, scoreIp } from "#/features/ip-check/score";
import { applyIntelligence } from "#/features/ip-check/server/lookup";

const clean = {
	datacenter: false,
	vpn: false,
	proxy: false,
	tor: false,
	org: "Example ISP",
	asn: 12345,
};
describe("MIT scoring parity and feature ablations", () => {
	it.each([
		[{}, "US", 0, 100, "residential"],
		[{ datacenter: true }, "US", 33, 60, "hosting"],
		[{ vpn: true }, "US", 50, 40, "vpn"],
		[{ tor: true }, "US", 75, 25, "tor"],
		[{ proxy: true }, "US", 100, 0, "residential-proxy"],
		[{ datacenter: true, vpn: true }, "US", 83, 17, "vpn/hosting"],
		[{ datacenter: true, org: "Alibaba" }, "US", 58, 42, "hosting"],
		[{}, "CN", 0, 40, "residential"],
		[{}, "RU", 0, 5, "residential"],
	] as const)("matches upstream %j/%s", (signals, country, risk, score, type) => {
		expect(scoreIp({ ...clean, ...signals }, country)).toMatchObject({
			risk,
			score,
			type,
		});
	});
	it("removing each real signal changes only its contribution", () => {
		expect(
			scoreIp({ ...clean, datacenter: true, vpn: true }, "US").risk -
				scoreIp({ ...clean, datacenter: true }, "US").risk,
		).toBe(50);
		expect(
			scoreIp({ ...clean, datacenter: true }, "US").risk -
				scoreIp(clean, "US").risk,
		).toBe(33);
	});
	it.each([
		[0.0005, 0],
		[0.000501, 10],
		[0.0085, 10],
		[0.008501, 20],
		[0.03, 20],
		[0.03001, 30],
		[0.2, 30],
		[0.20001, 40],
	] as const)("uses upstream abuse boundary %s", (fraction, points) =>
		expect(abusePoints(fraction)).toBe(points));
	it("does not ignore additional provider abuse risk", () => {
		const base = ipCheckSchema.parse({
			ip: "203.0.113.10",
			country: "US",
			city: null,
			asn: 12345,
			organization: "Example",
			colo: null,
			region: "listed",
			hosting: "unknown",
			status: "limited",
		});
		const result = applyIntelligence(base, {
			network: { asn: "AS12345", organisation: "Example", type: "Residential" },
			location: { country_code: "US", city_name: "Example" },
			detections: {
				proxy: false,
				vpn: false,
				tor: false,
				hosting: false,
				risk: 80,
			},
		});
		expect(result).toMatchObject({
			score: 20,
			risk: 80,
			mode: "intelligence",
			providerRisk: 80,
		});
		expect(result.flags.anycast).toBeNull();
	});
	it("missing threat fields cannot be treated as negative", () => {
		expect(() =>
			applyIntelligence({} as never, {
				network: {},
				location: {},
				detections: {},
			}),
		).toThrow();
	});
});
