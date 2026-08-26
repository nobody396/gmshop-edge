import { describe, expect, it } from "vitest";
import {
	parseDevice,
	webSupportConversationSchema,
	webSupportPollIntervalMs,
} from "#/features/telegram/web-support-contract";

describe("Telegram web support", () => {
	it("checks for administrator replies within one second", () => {
		expect(webSupportPollIntervalMs).toBe(1_000);
	});

	it("classifies common desktop, phone, and tablet user agents", () => {
		expect(
			parseDevice(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36",
			).device,
		).toBe("Desktop · Windows");
		expect(
			parseDevice(
				"Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/AP3A) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36",
			).device,
		).toBe("Phone");
		expect(
			parseDevice(
				"Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
			).device,
		).toBe("Tablet · Apple iPad");
	});

	it("accepts only bounded public keys and fingerprint identifiers", () => {
		const valid = {
			email: "customer@example.com",
			visitorId: "2ee02db9-c7b7-4728-8399-537d4e6c1e9c",
			publicKeyJwk: { kty: "RSA", n: "a".repeat(342), e: "AQAB" },
			fingerprint: { visitorId: "a".repeat(32), version: "5.2.0" },
			diagnostics: { locale: "en-US", timeZone: "Asia/Shanghai" },
		};
		expect(webSupportConversationSchema.safeParse(valid).success).toBe(true);
		expect(
			webSupportConversationSchema.safeParse({
				...valid,
				fingerprint: { visitorId: "raw components", version: "5.2.0" },
			}).success,
		).toBe(false);
	});
});
