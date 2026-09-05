// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
	ChatGptRegionGuide,
	chatGptRechargeProductId,
} from "#/features/storefront/components/chatgpt-region-guide";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ChatGPT region guide", () => {
	let root: ReturnType<typeof createRoot> | undefined;
	let container: HTMLDivElement | undefined;

	afterEach(async () => {
		await act(async () => root?.unmount());
		container?.remove();
		root = undefined;
		container = undefined;
	});

	it("explains the purchase decision without claiming different product legitimacy", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => root?.render(<ChatGptRegionGuide />));

		const text = container.textContent ?? "";
		expect(text).toContain("Philippines recharge");
		expect(text).toContain("US iOS recharge");
		expect(text).toContain("Cannot replace an active subscription");
		expect(text).toContain("Supports replacement");
		expect(text).toContain("you do not provide an Apple ID");
		expect(text).toContain("remaining time is not added");
		expect(text).toContain("Price differences come from recharge channels");
		expect(text).toContain("official ChatGPT account");
		expect(container.querySelectorAll("article")).toHaveLength(2);
	});

	it("appears for the shared ChatGPT product on product and checkout pages", () => {
		expect(chatGptRechargeProductId).toBe(
			"2a794b89-3bb9-49d4-8691-0d13a1606869",
		);
		const product = readFileSync(
			join(process.cwd(), "src/features/storefront/pages/product.tsx"),
			"utf8",
		);
		const checkout = readFileSync(
			join(process.cwd(), "src/features/storefront/pages/checkout.tsx"),
			"utf8",
		);
		expect(product).toContain(
			"data.id === chatGptRechargeProductId ? <ChatGptRegionGuide /> : null",
		);
		expect(product).toContain('href="#chatgpt-region-guide"');
		expect(checkout).toContain(
			"items.some((item) => item.productId === chatGptRechargeProductId)",
		);
		expect(checkout).toContain("<ChatGptRegionGuide />");
	});
});
