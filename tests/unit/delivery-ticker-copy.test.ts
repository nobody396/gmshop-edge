import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the ticker short and directs after-sales users to live support", () => {
	const zh = JSON.parse(
		readFileSync("messages/zh-CN.json", "utf8"),
	).store_delivery_ticker;
	const en = JSON.parse(
		readFileSync("messages/en-US.json", "utf8"),
	).store_delivery_ticker;
	expect(zh).toBe(
		"24 小时自动发货，有需要直接下单即可｜没货的商品，找客服补就行｜售后点页面右下角的客服；没回复多半是在睡觉，醒了第一时间处理，感谢理解",
	);
	expect(zh).not.toMatch(/人工采购|订单 CDK|Telegram 群聊\/私聊/);
	expect(en).toContain(
		"For after-sales, use the support button at the bottom right.",
	);
	expect(en).not.toMatch(
		/manually sourced|order CDK|Telegram group\/private chat/,
	);
});
