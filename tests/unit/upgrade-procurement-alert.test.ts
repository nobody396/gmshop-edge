import { expect, it } from "vitest";
import { formatProcurementAlert } from "#/features/ops-automation/server/procurement-alerts";

it("formats upgrade reviews with the paid amount and optional wallet debit, never as a stock purchase", () => {
	const input = {
		id: 1,
		kind: "needs_review" as const,
		source: "upgrade",
		sku: "GPT_UPGRADE",
		product_name: "ChatGPT 升级",
		code_suffix: "ABC123",
		reason: "升级状态不明",
		price_minor: 121000,
		balance_minor: 110000,
	};
	expect(formatProcurementAlert(input, { alerts: [], waiting: [] })).toBe(
		"⚠️ ChatGPT 升级需要人工处理\n单号 …ABC123，客户实付 ¥1210.00（上游实扣 ¥1100.00）\n原因：升级状态不明\n先核对是否已扣上游钱包，再决定在卡网后台退款；不要让客户重复下单。",
	);
	expect(
		formatProcurementAlert(
			{ ...input, balance_minor: null },
			{ alerts: [], waiting: [] },
		),
	).not.toContain("上游实扣");
});
