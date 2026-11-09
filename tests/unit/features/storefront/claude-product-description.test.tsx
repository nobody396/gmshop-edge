import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	ClaudeKycNotice,
	splitClaudeKycNotice,
} from "../../../../src/features/storefront/components/claude-product-description";

const title = "重要提示｜Claude 身份验证（KYC）";
const notice =
	"开通 Claude Max 5X / Max 20X 订阅百分百需要 KYC 身份验证。这是 Claude 官方的验证要求，与本店充值无关。本店仅负责订阅充值，KYC 需买家自行解决，不提供代办或通过保证。无法自行完成验证的，请勿下单。";
function render(description: string) {
	const split = splitClaudeKycNotice(description);
	if (!split) return null;
	return {
		...split,
		html: renderToStaticMarkup(
			createElement(ClaudeKycNotice, {
				title: split.title,
				notice: split.notice,
			}),
		),
	};
}
describe("Claude KYC description", () => {
	it("keeps the owner's notice verbatim, without highlighter marks", () => {
		const result = render(`${title}\n${notice}\n\n原商品介绍`);
		expect(result?.html).not.toContain("<mark");
		expect(result?.html.replace(/<[^>]+>/g, "")).toBe(`${title}${notice}`);
		expect(result?.remaining).toBe("原商品介绍");
	});
	it("keeps multi-line notices and the remaining description intact", () => {
		const ageNotice =
			"新账号禁止充值 5X / 20X 订阅，提交的账号必须已注册至少一个月，否则可能存在不到账的情况。由于该情况无法事先检测，请确认无误后充值。";
		const result = render(`${title}\n${ageNotice}\n${notice}\n\n原商品介绍`);
		expect(result?.notice).toBe(`${ageNotice}\n${notice}`);
		expect(result?.html.replace(/<[^>]+>/g, "")).toBe(
			`${title}${ageNotice}\n${notice}`,
		);
		expect(result?.remaining).toBe("原商品介绍");
	});
	it("leaves descriptions without the exact notice header alone, including English", () => {
		for (const description of [
			"Claude membership recharge",
			"普通说明",
			`${title}\n未完整保存`,
		])
			expect(splitClaudeKycNotice(description)).toBeNull();
	});
	it("escapes stored markup rather than injecting HTML", () => {
		expect(
			render(`${title}\n<script>alert(1)</script>\n\n介绍`)?.html,
		).not.toContain("<script>");
	});
});
