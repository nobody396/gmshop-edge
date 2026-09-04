import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	feishuAlertSettingsInputSchema,
	formatFeishuWebSupportAlert,
	sendFeishuText,
} from "#/features/telegram/server/feishu-alerts";
import {
	parseDevice,
	webSupportConversationSchema,
	webSupportOpenEvent,
	webSupportPollIntervalMs,
} from "#/features/telegram/web-support-contract";

describe("Telegram web support", () => {
	it("uses a WeChat dialog without a universal order-CDK handoff", () => {
		const source = readFileSync(
			new URL(
				"../../src/features/telegram/components/web-support-widget.tsx",
				import.meta.url,
			),
			"utf8",
		);
		expect(source).not.toContain("m.web_support_order_notice()");
		expect(source).toContain("m.web_support_wechat_fallback()");
		expect(source).toContain("<DialogTrigger asChild>");
		expect(source).toContain("src={wechatQrUrl}");
		expect(source).not.toContain("href={wechatQrUrl}");
	});

	it("checks for administrator replies within one second", () => {
		expect(webSupportPollIntervalMs).toBe(1_000);
		expect(webSupportOpenEvent).toBe("gmshop:web-support:open");
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

	it("validates complete Feishu application-bot identifiers", () => {
		const valid = {
			enabled: true,
			appId: "cli_1234567890abcdef",
			appSecret: "test-only-secret",
			chatId: "oc_1234567890abcdef",
		};
		expect(feishuAlertSettingsInputSchema.parse(valid)).toEqual(valid);
		expect(
			feishuAlertSettingsInputSchema.safeParse({
				...valid,
				chatId: "123456",
			}).success,
		).toBe(false);
	});

	it("formats a Beijing-time alert with the customer message", () => {
		const message = formatFeishuWebSupportAlert(
			"Web · cu***@example.com · visitor1",
			"账号自己提供对吧？",
			Date.UTC(2026, 8, 1, 6, 30),
		);
		expect(message).toContain("🔔 网页客服新消息");
		expect(message).toContain("客户：Web · cu***@example.com · visitor1");
		expect(message).toContain("内容：账号自己提供对吧？");
		expect(message).toContain("2026-09-01 14:30");
	});

	it("sends one Feishu text message through the configured application bot", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const request = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			calls.push({ url: String(input), init });
			if (calls.length === 1)
				return Response.json({
					code: 0,
					tenant_access_token: "tenant-token-test-only",
					expire: 7_200,
				});
			return Response.json({ code: 0, data: { message_id: "om_test" } });
		}) as typeof fetch;
		await sendFeishuText(
			{
				appId: "cli_1234567890abcdef",
				appSecret: "test-only-secret-unique",
				chatId: "oc_1234567890abcdef",
			},
			"网页客服新消息",
			request,
		);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toContain("tenant_access_token/internal");
		expect(calls[1]?.url).toContain("receive_id_type=chat_id");
		expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
			receive_id: "oc_1234567890abcdef",
			msg_type: "text",
			content: JSON.stringify({ text: "网页客服新消息" }),
		});
	});
});
