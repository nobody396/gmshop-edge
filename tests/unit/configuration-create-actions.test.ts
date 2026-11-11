import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const configurationPages = [
	"../../src/features/auth/pages/providers.tsx",
	"../../src/features/notifications/pages/email-configurations.tsx",
	"../../src/features/shop-payments/pages/admin.tsx",
] as const;

describe("configuration create actions", () => {
	it("uses the same primary provider-picker interaction", async () => {
		for (const path of configurationPages) {
			const source = await readFile(new URL(path, import.meta.url), "utf8");
			expect(source, path).toContain("<DropdownMenuTrigger asChild>");
			expect(source, path).toContain("<Plus />");
			expect(source, path).toContain("<ChevronDown />");
			expect(source, path).toContain('className="max-h-80 overflow-y-auto"');
		}
	});

	it("opens email creation with the selected provider", async () => {
		const source = await readFile(
			new URL(configurationPages[1], import.meta.url),
			"utf8",
		);
		expect(source).toContain("emailProviderValues.map((provider)");
		expect(source).toContain("setCreatingProvider(provider)");
		expect(source).toContain("emailConfigValues(editing, creatingProvider)");
	});

	it("uses a responsive two-column payment form", async () => {
		const source = await readFile(
			new URL(configurationPages[2], import.meta.url),
			"utf8",
		);
		expect(source).toContain(
			'fieldsClassName="grid gap-4 space-y-0 sm:grid-cols-2"',
		);
		expect(source).toContain('className: "sm:col-span-2"');
		// Alipay channels choose 网站支付 (page/wap picked per device) or 订单码支付.
		expect(source).toContain('name: "alipayMode"');
		expect(source).not.toContain('name: "wechatMode"');
		expect(source).toContain(
			'return values.alipayMode === "qr" ? "alipay_qr" : "alipay_page"',
		);
		expect(source).toContain('if (type === "wechat") return "wechat_native"');
		expect(source).toContain('name: "epusdtPaymentMethod"');
		expect(source).toContain("onPendingChange={setCreatingLogo}");
		expect(source.match(/<ConfigurationLogoField/g)).toHaveLength(2);
		expect(source).toContain(
			'provider === "alipay_page" || provider === "alipay_wap"',
		);
		expect(source).toContain(
			'provider === "wechat_native" || provider === "wechat_h5"',
		);
		const providerMenu = source.slice(
			source.indexOf("const paymentProviderMenu"),
		);
		expect(providerMenu.indexOf('family: "gmpay"')).toBeLessThan(
			providerMenu.indexOf('family: "alipay"'),
		);
		expect(providerMenu.indexOf('family: "alipay"')).toBeLessThan(
			providerMenu.indexOf('family: "wechat"'),
		);
		expect(providerMenu.indexOf('family: "wechat"')).toBeLessThan(
			providerMenu.indexOf('family: "stripe"'),
		);
	});
});
