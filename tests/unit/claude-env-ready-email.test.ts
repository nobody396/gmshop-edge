import { describe, expect, it } from "vitest";
import { renderClaudeEnvReadyEmail } from "#/features/claude-env/server/customer-email";

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
			"https://laoshirenvip.com/guides/claude-env-setup",
		);
		expect(mail.text).toContain("重启电脑一次");
		expect(mail.text).toContain("本月流量、到期时间");
	});

	it("drops the lines the owner removed and never carries the code", () => {
		expect(mail.text).not.toContain("英文对话");
		expect(mail.text).not.toContain("200GB");
		expect(mail.text).not.toContain("注销");
		expect(mail.text).not.toContain("住宅");
		expect(mail.text).not.toMatch(/CE1-/);
	});
});
