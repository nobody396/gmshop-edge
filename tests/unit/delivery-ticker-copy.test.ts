import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the ticker short and directs after-sales users to live support", () => {
	const zh = JSON.parse(
		readFileSync("messages/zh-CN.json", "utf8"),
	).store_delivery_ticker;
	const en = JSON.parse(
		readFileSync("messages/en-US.json", "utf8"),
	).store_delivery_ticker;
	expect(zh).toBe("有需要直接下单即可｜24 小时自动发货｜有问题联系在线客服");
	expect(zh).not.toMatch(/人工采购|订单 CDK|Telegram 群聊\/私聊/);
	expect(en).toContain("Questions? Contact live support");
	expect(en).not.toMatch(
		/manually sourced|order CDK|Telegram group\/private chat/,
	);
});
