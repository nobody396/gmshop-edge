import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the ticker short and directs after-sales users to the page support button", () => {
	const zh = JSON.parse(
		readFileSync("messages/zh-CN.json", "utf8"),
	).store_delivery_ticker;
	const en = JSON.parse(
		readFileSync("messages/en-US.json", "utf8"),
	).store_delivery_ticker;
	expect(zh).toBe(
		"24 小时自动充值交付，直接下单即可｜没货的产品，进群发消息问就完了｜所有售后问题请通过页面客服按钮联系即可；没回复就是在睡觉，醒来会尽快处理，感谢理解",
	);
	expect(zh).not.toMatch(/人工采购|订单 CDK|Telegram 群聊\/私聊/);
	expect(en).toContain(
		"For all after-sales questions, use the customer support button on this page.",
	);
	expect(en).not.toMatch(
		/manually sourced|order CDK|Telegram group\/private chat/,
	);
});
