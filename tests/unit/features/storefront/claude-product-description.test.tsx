import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClaudeProductDescription } from "../../../../src/features/storefront/components/claude-product-description";

const title = "重要提示｜Claude Max 身份验证（KYC）";
const notice =
	"开通 Claude Max 5X / Max 20X 订阅百分百需要 KYC 身份验证。这是 Claude 官方的验证要求，与本店充值无关。本店仅负责订阅充值，KYC 需买家自行解决，不提供代办或通过保证。无法自行完成验证的，请勿下单。";
function render(description: string) {
	return renderToStaticMarkup(
		createElement(ClaudeProductDescription, { description }),
	);
}
describe("Claude KYC description", () => {
	it("highlights the existing notice without changing or duplicating its wording", () => {
		const html = render(`${title}\n${notice}\n\n原商品介绍`);
		expect(html).toContain('aria-labelledby="claude-max-kyc-title"');
		expect(html.match(/<mark /g)).toHaveLength(3);
		expect(html.replace(/<[^>]+>/g, "")).toBe(`${title}${notice}原商品介绍`);
		expect(html).toContain("dark:bg-amber-950");
	});
	it("preserves descriptions without the exact notice header, including English", () => {
		for (const description of [
			"Claude membership recharge",
			"普通说明",
			`${title}\n未完整保存`,
		]) {
			const html = render(description);
			expect(html).not.toContain("<section");
			expect(html.replace(/<[^>]+>/g, "")).toBe(description);
		}
	});
	it("escapes stored markup rather than injecting HTML", () => {
		expect(render(`${title}\n<script>alert(1)</script>\n\n介绍`)).not.toContain(
			"<script>",
		);
	});
});
