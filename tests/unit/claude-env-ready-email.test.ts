import { describe, expect, it } from "vitest";
import {
	renderClaudeEnvExpiryEmail,
	renderClaudeEnvReadyEmail,
} from "#/features/claude-env/server/customer-email";

describe("Claude env ready email", () => {
	const mail = renderClaudeEnvReadyEmail({
		orderUrl: "https://laoshirenvip.com/account/orders/GM1",
		expiresText: "2026-11-25 16:55",
		email: "buyer@example.com",
		ip: "161.77.8.204",
		city: "Springfield, Massachusetts",
	});

	it("tells the buyer the IP, how to sign in and where the guide is", () => {
		expect(mail.text).toContain(
			"专属 IP：161.77.8.204（Springfield, Massachusetts）",
		);
		expect(mail.text).toContain("用下单邮箱 buyer@example.com 登录");
		expect(mail.text).toContain("忘记密码");
		expect(mail.text).toContain(
			"https://laoshirenvip.com/account/claude-env-guide",
		);
		expect(mail.text).toContain("重启电脑一次");
		expect(mail.text).toContain("本月流量、到期时间");
		expect(mail.text).toContain("交给 AI 助手配置");
	});

	it("drops the lines the owner removed and never carries the code", () => {
		expect(mail.text).not.toContain("英文对话");
		expect(mail.text).not.toContain("200GB");
		expect(mail.text).not.toContain("注销");
		expect(mail.text).not.toContain("住宅");
		expect(mail.text).not.toMatch(/CE1-/);
	});

	it("sends an agent-site customer to their own environments page", () => {
		const reseller = renderClaudeEnvReadyEmail({
			orderUrl: "https://laoshirenvip.com/account/claude-env",
			viaReseller: true,
			expiresText: "2026-11-25 16:55",
			email: "end@example.com",
			ip: "161.77.8.204",
			city: null,
		});
		expect(reseller.text).toContain(
			"登录后打开「我的 Claude 专属环境」→ https://laoshirenvip.com/account/claude-env",
		);
		expect(reseller.text).not.toContain("我的订单");
		expect(reseller.text).not.toContain("订单页");
	});

	it("expiry reminders to agent-site customers do not point at an order page", () => {
		const base = {
			locale: "zh-CN" as const,
			daysLeft: 3,
			expiresAt: Date.UTC(2026, 10, 25),
			plan: "monthly",
			renewUrl: "https://laoshirenvip.com/products/x",
			unsubscribeUrl: null,
		};
		expect(renderClaudeEnvExpiryEmail(base).text).toContain("订单页");
		const reseller = renderClaudeEnvExpiryEmail({ ...base, viaReseller: true });
		expect(reseller.text).not.toContain("订单页");
		expect(reseller.text).toContain("右下角「联系客服」");
	});
});
