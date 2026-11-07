import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClaudeProductDescription } from "../../../../src/features/storefront/components/claude-product-description";

const title = "重要提示｜Claude 身份验证（KYC）";
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
	it("emphasizes account-age limits and risks without adding a numbered marker", () => {
		const ageNotice =
			"新账号禁止充值 5X / 20X 订阅，提交的账号必须已注册至少一个月，否则可能存在不到账的情况。由于该情况无法事先检测，请确认无误后充值。";
		const html = render(`${title}\n${ageNotice}\n${notice}\n\n原商品介绍`);
		expect(html.match(/<mark /g)).toHaveLength(7);
		for (const phrase of [
			"新账号禁止充值",
			"已注册至少一个月",
			"可能存在不到账",
			"无法事先检测",
		]) {
			expect(html).toContain(`>${phrase}</mark>`);
		}
		expect(html).not.toContain("⑤");
		expect(html.replace(/<[^>]+>/g, "")).toBe(
			`${title}${ageNotice}\n${notice}原商品介绍`,
		);
	});
	it("highlights the self-check guidance", () => {
		const guidance =
			"下单前先到兑换站「Claude 账号自查」检查账号：显示要求身份认证（KYC）的，请先完成认证再充值；没有该标记的账号大多免 KYC，可以直接充值。充值后 Claude 仍可能临时要求认证，这种情况本店不负责，可能不到账且不退款。\nClaude Pro / Max 只支持 2026 年 9 月 15 日前注册的账号。";
		const html = render(`${title}\n${guidance}\n\n介绍`);
		expect(html.match(/<mark /g)).toHaveLength(5);
		expect(html.replace(/<[^>]+>/g, "")).toBe(`${title}${guidance}介绍`);
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
