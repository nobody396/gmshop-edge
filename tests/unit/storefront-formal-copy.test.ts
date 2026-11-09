import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps customer-facing storefront copy free of the old away-message ticker", () => {
	const zh = JSON.parse(readFileSync("messages/zh-CN.json", "utf8"));
	expect(zh.store_delivery_ticker).toBeUndefined();
	const storefront = Object.entries(zh)
		.filter(([key]) => key.startsWith("store_") || key.startsWith("public_"))
		.map(([, value]) => String(value))
		.join("\n");
	expect(storefront).not.toMatch(/睡觉|醒了/);
	const layout = readFileSync("src/layouts/public/index.tsx", "utf8");
	expect(layout).not.toContain("DeliveryTicker");
});
