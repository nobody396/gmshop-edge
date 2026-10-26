import { describe, expect, it } from "vitest";
import {
	canonicalTimezone,
	customerCommands,
	dayMs,
	decodeActivationCode,
	displayCity,
	encodeActivationCode,
	evaluateQuality,
	extendExpiry,
	generateRelayPass,
	generateRelayUser,
	generateSubscriptionId,
	isIanaTimezone,
	isIpv4,
	parseIproyalDate,
	parseScamalyticsScore,
	pickIproyalCity,
	pickRelayPort,
	sha256Hex,
	signRelayRequest,
	timezoneForCity,
	trafficPeriodStart,
} from "#/features/claude-env/domain";

describe("relay request signature (CONTROL_API.md 签名测试向量)", () => {
	// Key = the secret string's UTF-8 bytes (64 hex chars used as-is, NOT hex-decoded).
	const vectors = [
		{
			secret:
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			method: "GET",
			path: "/api/claude-env/relay/v1/desired",
			timestamp: "1793001600",
			body: "",
			bodyHash:
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			signature:
				"b3e8df28ae312d7c7810cf39c441c9f209aeab3b8279c1ac35c720bd340ace11",
		},
		{
			secret:
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			method: "POST",
			path: "/api/claude-env/relay/v1/report",
			timestamp: "1793001630",
			body: '{"report_id":"3f6c2a64-6b1e-4c39-9d0e-2b6a9f2f7c11","relay_id":"r1"}',
			bodyHash:
				"8b1cad58fc8582d4729444fdfe5f368b41be46aa53421026f6598630a978a103",
			signature:
				"5db299ca8d0aacd440989afb46cc7722ccc501b6e896297f6f9ca77bf9241024",
		},
		{
			secret:
				"ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
			method: "POST",
			path: "/api/claude-env/relay/v1/report?dry=1",
			timestamp: "1793001660",
			body: '{"id":"测试"}',
			bodyHash:
				"25b934de6e9aff261f8ddd9bbd33fbf9fb01cc0e4bb2c9ab3dda7bffd393ec26",
			signature:
				"4c9f776871f9168aa17b52d806e76648a11c27646ebd459d938f8ae76c28c87d",
		},
		// Own vector, computed with Python hmac.new(secret.encode(), msg.encode(), sha256).
		{
			secret:
				"9f2c6d1e8b7a4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d",
			method: "POST",
			path: "/api/claude-env/relay/v1/report",
			timestamp: "1792800030",
			body: '{"report_id":"r-1"}',
			bodyHash: null,
			signature:
				"485f7ccda7f4dc4515a783542327daf0203ed96ed15110d9c05cf9397c23ad34",
		},
	];
	for (const [index, vector] of vectors.entries())
		it(`matches vector ${index + 1}`, async () => {
			if (vector.bodyHash)
				expect(await sha256Hex(vector.body)).toBe(vector.bodyHash);
			expect(await signRelayRequest(vector)).toBe(vector.signature);
			expect(
				await signRelayRequest({
					...vector,
					body: new TextEncoder().encode(vector.body),
				}),
			).toBe(vector.signature);
		});
});

describe("activation code", () => {
	it("is byte-identical to relay/ce-relay `code` (Python json.dumps compact + urlsafe b64 no padding)", () => {
		// python3: json.dumps(payload, separators=(",", ":"), ensure_ascii=False) → base64.urlsafe_b64encode().rstrip("=")
		const expected =
			"CE1-eyJ2IjoxLCJob3N0IjoicmVsYXkuZXhhbXBsZS5jb20iLCJwb3J0IjoyMDAwMSwidXNlciI6InUzZjlhMGIxYzJkM2UiLCJwYXNzIjoiWmtfOS1hQmNEZUZnSGlKa0xtTm9QcVJzIiwiaXAiOiIxNjEuNzcuOC4yMDQiLCJ0eiI6IkFtZXJpY2EvTmV3X1lvcmsifQ";
		const code = encodeActivationCode({
			host: "relay.example.com",
			port: 20001,
			user: "u3f9a0b1c2d3e",
			pass: "Zk_9-aBcDeFgHiJkLmNoPqRs",
			ip: "161.77.8.204",
			tz: "America/New_York",
		});
		expect(code).toBe(expected);
		expect(code).not.toMatch(/[=+/]/);
		expect(decodeActivationCode(code)).toEqual({
			v: 1,
			host: "relay.example.com",
			port: 20001,
			user: "u3f9a0b1c2d3e",
			pass: "Zk_9-aBcDeFgHiJkLmNoPqRs",
			ip: "161.77.8.204",
			tz: "America/New_York",
		});
	});

	it("builds the exact customer commands", () => {
		const commands = customerCommands("CE1-abc");
		expect(commands.mac).toBe(
			"curl -fsSL https://laoshirenvip.com/claude-env.sh -o /tmp/claude-env.sh && bash /tmp/claude-env.sh 'CE1-abc'",
		);
		expect(commands.windows).toBe(
			"irm https://laoshirenvip.com/claude-env.ps1 -OutFile $env:TEMP\\claude-env.ps1; powershell -ExecutionPolicy Bypass -File $env:TEMP\\claude-env.ps1 -Code 'CE1-abc'",
		);
		expect(commands.ipCheck).toBe("https://laoshirenvip.com/ip-check");
	});
});

describe("credentials and ports", () => {
	it("generates relay credentials in the agreed formats", () => {
		for (let i = 0; i < 50; i += 1) {
			expect(generateRelayUser()).toMatch(/^u[0-9a-f]{12}$/);
			expect(generateRelayPass()).toMatch(/^[A-Za-z0-9_-]{24}$/);
			expect(generateSubscriptionId()).toMatch(/^sub_[0-9a-f]{20}$/);
		}
	});

	it("picks the lowest free port in 20000–20999", () => {
		expect(pickRelayPort([])).toBe(20000);
		expect(pickRelayPort([20000, 20001, 20003])).toBe(20002);
		expect(
			pickRelayPort(Array.from({ length: 1000 }, (_, i) => 20000 + i)),
		).toBeNull();
	});
});

describe("IPRoyal city picker", () => {
	const products = (names: Array<[number, string, boolean?]>) => ({
		data: [
			{ id: 3, locations: [] },
			{
				id: 9,
				locations: [
					{
						id: 5,
						child_locations: [{ id: 1, name: "Springfield (Massachusetts)" }],
					},
					{
						id: 16,
						child_locations: names.map(([id, name, out]) => ({
							id,
							name,
							out_of_stock: out ?? false,
						})),
					},
				],
			},
		],
	});

	it("prefers exactly Springfield (Massachusetts)", () => {
		expect(
			pickIproyalCity(
				products([
					[100, "Seattle"],
					[101, "New York"],
					[102, "Springfield"],
					[187, "Springfield (Massachusetts)"],
				]),
			)?.id,
		).toBe(187);
	});

	it("falls back east, then west, then anything, skipping out-of-stock", () => {
		expect(
			pickIproyalCity(
				products([
					[187, "Springfield (Massachusetts)", true],
					[100, "Seattle"],
					[110, "Washington (District Of Columbia)"],
				]),
			)?.id,
		).toBe(110);
		expect(
			pickIproyalCity(
				products([
					[100, "Dallas"],
					[101, "Los Angeles"],
				]),
			)?.id,
		).toBe(101);
		expect(pickIproyalCity(products([[100, "Dallas"]]))?.id).toBe(100);
		expect(pickIproyalCity(products([[100, "Dallas", true]]))).toBeNull();
		expect(pickIproyalCity({})).toBeNull();
	});

	it("maps cities to IANA zones and formats names", () => {
		expect(timezoneForCity("Springfield (Massachusetts)")).toBe(
			"America/New_York",
		);
		expect(timezoneForCity("Seattle")).toBe("America/Los_Angeles");
		expect(timezoneForCity("Seattle (Washington)")).toBe("America/Los_Angeles");
		expect(timezoneForCity(null)).toBe("America/New_York");
		expect(isIanaTimezone("America/Chicago")).toBe(true);
		expect(isIanaTimezone("EST")).toBe(false);
		expect(isIanaTimezone("Mars/Base")).toBe(false);
		expect(displayCity("Springfield (Massachusetts)")).toBe(
			"Springfield, Massachusetts",
		);
	});
});

describe("quality thresholds", () => {
	it("passes at trust 80 and scam 40, fails at 79 / 41", () => {
		expect(evaluateQuality({ trustScore: 80, scamScore: 40 }).pass).toBe(true);
		expect(evaluateQuality({ trustScore: 79.9, scamScore: 40 }).pass).toBe(
			false,
		);
		expect(evaluateQuality({ trustScore: 80, scamScore: 41 }).pass).toBe(false);
	});

	it("only warns when a lookup is unavailable", () => {
		const result = evaluateQuality({ trustScore: null, scamScore: null });
		expect(result.pass).toBe(true);
		expect(result.warns).toHaveLength(2);
	});

	it("reads the scamalytics fraud score", () => {
		expect(parseScamalyticsScore("<div>Fraud Score: 32</div>")).toBe(32);
		expect(parseScamalyticsScore("blocked")).toBeNull();
	});
});

describe("dates", () => {
	const now = Date.parse("2026-10-24T00:00:00Z");
	it("extends from max(now, expires)", () => {
		expect(extendExpiry(now + 5 * dayMs, now, 30)).toBe(now + 35 * dayMs);
		expect(extendExpiry(now - 2 * dayMs, now, 30)).toBe(now + 30 * dayMs);
		expect(extendExpiry(null, now, 90)).toBe(now + 90 * dayMs);
	});
	it("rolls 30-day traffic periods from activation", () => {
		expect(trafficPeriodStart(now, now + 29 * dayMs)).toBe(now);
		expect(trafficPeriodStart(now, now + 30 * dayMs)).toBe(now + 30 * dayMs);
		expect(trafficPeriodStart(now, now + 61 * dayMs)).toBe(now + 60 * dayMs);
	});
});

describe("review additions", () => {
	it("folds US zone aliases onto the 7 canonical zones the Windows script maps", () => {
		expect(canonicalTimezone("America/Indiana/Indianapolis")).toBe(
			"America/New_York",
		);
		expect(canonicalTimezone("America/Detroit")).toBe("America/New_York");
		expect(canonicalTimezone("America/Kentucky/Louisville")).toBe(
			"America/New_York",
		);
		expect(canonicalTimezone("America/Indiana/Knox")).toBe("America/Chicago");
		expect(canonicalTimezone("America/North_Dakota/Center")).toBe(
			"America/Chicago",
		);
		expect(canonicalTimezone("America/Menominee")).toBe("America/Chicago");
		expect(canonicalTimezone("America/Boise")).toBe("America/Denver");
		expect(canonicalTimezone("US/Arizona")).toBe("America/Phoenix");
		expect(canonicalTimezone("America/Juneau")).toBe("America/Anchorage");
		expect(canonicalTimezone("US/Hawaii")).toBe("Pacific/Honolulu");
		expect(canonicalTimezone("America/Los_Angeles")).toBe(
			"America/Los_Angeles",
		);
		expect(canonicalTimezone("Asia/Singapore")).toBe("Asia/Singapore");
	});

	it("validates IPv4 and parses IPRoyal dates as UTC", () => {
		expect(isIpv4("161.77.8.204")).toBe(true);
		expect(isIpv4("256.1.1.1")).toBe(false);
		expect(isIpv4("2001:db8::1")).toBe(false);
		expect(parseIproyalDate("2024-04-20 10:25:12")).toBe(
			Date.parse("2024-04-20T10:25:12Z"),
		);
		expect(parseIproyalDate("soon")).toBeNull();
		expect(parseIproyalDate(null)).toBeNull();
	});
});
