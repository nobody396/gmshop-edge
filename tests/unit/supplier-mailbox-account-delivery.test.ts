import { describe, expect, it } from "vitest";
import { supplierDeliveryContent } from "#/features/suppliers/server/process";

describe("supplier mailbox account delivery", () => {
	it("spells out a Muse AI finished account with its sign-in steps", () => {
		const content = supplierDeliveryContent(
			"tyler.hall115@mail.com kTMKTK7QOH4u3MaI mailbox: mail.com",
			"https://muse.ai/",
		);
		expect(content).toBe(
			[
				"账号邮箱：tyler.hall115@mail.com",
				"邮箱密码：kTMKTK7QOH4u3MaI",
				"邮箱网站：https://www.mail.com",
				"Muse AI 网址：https://muse.ai",
				"",
				"使用步骤：",
				"1. 打开 https://www.mail.com ，用上面的「账号邮箱」和「邮箱密码」登录。这个邮箱是用来收验证码的。",
				"2. 新开一个页面，打开 https://muse.ai ，输入上面的账号邮箱，点「获取验证码」。",
				"3. 回到 mail.com 的收件箱，找到发来的验证码（没看到就看垃圾邮件），填回 Muse AI，完成登录。",
				"4. 登录后进入「设置」，就能看到账户里的 10 亿 Token。",
				"",
				"注意：验证码和邮箱密码不要告诉任何人。遇到问题请在 24 小时内联系客服。",
			].join("\n"),
		);
		expect(content).not.toMatch(/CDK|充值地址|mailbox:/);
	});

	it("keeps the CDK format for anything that is not a mailbox account", () => {
		expect(
			supplierDeliveryContent("ABCD-EFGH-IJKL", "https://redeem.example.com"),
		).toBe("CDK：ABCD-EFGH-IJKL\n充值地址：https://redeem.example.com");
		expect(
			supplierDeliveryContent("tyler@mail.com pass mailbox: mail.com", null),
		).toBe("tyler@mail.com pass mailbox: mail.com");
		expect(
			supplierDeliveryContent(
				"https://x.example/activate/abc",
				"https://y.example",
			),
		).toBe("https://x.example/activate/abc");
	});
});
