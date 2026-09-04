// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryMessage } from "#/features/storefront/components/delivery-message";
import { DeliveryRevealContent } from "#/features/storefront/components/delivery-reveal-content";
import { OrderDeliveryNotice } from "#/features/storefront/components/order-delivery-notice";
import { splitDeliveryMessage } from "#/features/storefront/delivery-message";

vi.mock("#/paraglide/messages", () => ({
	m: {
		store_copy_delivery: () => "复制",
		store_delivery_usage_entry: () => "充值 / 使用入口",
		store_delivery_usage_entry_hint: () => "使用上方卡密按提示操作",
		common_copy_success: () => "已复制",
		common_copy_failed: () => "复制失败",
		store_delivery_reveal_failed: () => "无法查看凭证",
		store_automatic_delivery_review_title: () => "自动交付暂未完成",
		store_automatic_delivery_review_description: () =>
			"请通过售后核对，不要重复购买",
		store_automatic_delivery_pending_title: () => "正在自动获取交付内容",
		store_automatic_delivery_pending_description: () =>
			"无需把订单号发送给客服。",
		store_activation_code_title: () => "激活凭证已发放",
		store_activation_code_description: () => "复制下方 CDK 并发送给客服。",
		store_activation_code_processing: () => "人工处理中",
		store_activation_code_label: () => "激活 CDK",
		store_activation_code_copy: () => "复制 CDK",
		store_activation_code_copied: () => "已复制",
		store_activation_code_support: () => "打开在线客服",
		store_activation_code_sla: () => "人工服务时效",
	},
}));

const orderNumber = `GM${"1".repeat(32)}`;
function delivery(
	fulfillmentSource: "supplier" | "manual" | "local",
	status = "awaiting_supply",
) {
	return {
		id: fulfillmentSource,
		type: "stock",
		status,
		fulfillmentSource,
		productName: `${fulfillmentSource} product`,
		sellableItemName: "SKU",
	};
}

describe("order delivery presentation", () => {
	it.each([
		"pending",
		"awaiting_supply",
		"processing",
	])("never presents a GM activation CDK for automatic %s deliveries", (status) => {
		for (const source of ["supplier", "local"] as const) {
			const html = renderToString(
				<OrderDeliveryNotice
					deliveries={[delivery(source, status)]}
					orderNumber={orderNumber}
				/>,
			);
			expect(html).toContain('data-fulfillment-flow="automatic"');
			expect(html).not.toContain(orderNumber);
			expect(html).not.toContain("复制 CDK");
			expect(html).not.toContain("激活凭证已发放");
		}
	});
	it("does not pretend a terminal supplier failure is still automatically processing", () => {
		const html = renderToString(
			<OrderDeliveryNotice
				deliveries={[{ ...delivery("supplier"), supplierState: "failed" }]}
				orderNumber={orderNumber}
			/>,
		);
		expect(html).toContain("自动交付暂未完成");
		expect(html).not.toContain("正在自动获取");
		expect(html).not.toContain(orderNumber);
		expect(html).not.toContain("复制 CDK");
	});

	it("keeps the order CDK handoff only for a manual delivery", () => {
		const html = renderToString(
			<OrderDeliveryNotice
				deliveries={[delivery("manual")]}
				orderNumber={orderNumber}
			/>,
		);
		expect(html).toContain(orderNumber);
		expect(html).toContain("打开在线客服");
		expect(html).not.toContain('data-fulfillment-flow="automatic"');
	});
	it("separates automatic and manual items in a mixed order", () => {
		const container = document.createElement("div");
		container.innerHTML = renderToString(
			<OrderDeliveryNotice
				deliveries={[delivery("supplier"), delivery("manual")]}
				orderNumber={orderNumber}
			/>,
		);
		expect(
			container.querySelector('[data-fulfillment-flow="automatic"]')
				?.textContent,
		).not.toContain(orderNumber);
		expect(
			container.querySelector('[data-fulfillment-flow="manual"]')?.textContent,
		).toContain(orderNumber);
	});
	it("removes waiting notices after delivery", () => {
		expect(
			renderToString(
				<OrderDeliveryNotice
					deliveries={[
						delivery("supplier", "delivered"),
						delivery("manual", "delivered"),
					]}
					orderNumber={orderNumber}
				/>,
			),
		).toBe("");
	});
	it("preserves the full text and makes returned recharge and tutorial URLs clickable", () => {
		const content =
			"卡密：TEST-CARD\n充值地址：https://redeem.example/claude\n教程：https://guide.example/claude。\n原样说明\n";
		const parts = splitDeliveryMessage(content);
		expect(parts.map((part) => part.text).join("")).toBe(content);
		expect(parts.filter((part) => part.href).map((part) => part.href)).toEqual([
			"https://redeem.example/claude",
			"https://guide.example/claude",
		]);
		const container = document.createElement("div");
		container.innerHTML = renderToString(<DeliveryMessage content={content} />);
		expect(container.querySelectorAll("a")).toHaveLength(2);
		expect(container.querySelector("a")?.rel).toBe("noopener noreferrer");
		expect(container.textContent).toContain(content);
	});
	it("shows an identity-verified entry beside a card-only payload without changing the payload", () => {
		const container = document.createElement("div");
		container.innerHTML = renderToString(
			<DeliveryMessage
				content="TEST-CARD"
				usageUrl="https://verified.example/redeem"
			/>,
		);
		expect(container.querySelector("a")?.href).toBe(
			"https://verified.example/redeem",
		);
		expect(container.textContent).toContain("TEST-CARD");
		expect(container.textContent).toContain("充值 / 使用入口");
	});

	it("does not duplicate an entry that is already in the upstream text", () => {
		const container = document.createElement("div");
		container.innerHTML = renderToString(
			<DeliveryMessage
				content="TEST-CARD\nhttps://verified.example/redeem"
				usageUrl="https://verified.example/redeem"
			/>,
		);
		expect(container.querySelectorAll("a")).toHaveLength(1);
	});

	it("does not invent an entry URL or execute upstream HTML", () => {
		const container = document.createElement("div");
		container.innerHTML = renderToString(
			<DeliveryMessage
				content={"TEST-CARD\n<script>alert(1)</script>\njavascript:alert(1)"}
			/>,
		);
		expect(container.querySelector("a, script")).toBeNull();
		expect(container.textContent).toContain("<script>alert(1)</script>");
		expect(
			splitDeliveryMessage("https://user:pass@example.com/redeem").some(
				(part) => part.href,
			),
		).toBe(false);
	});
});

describe("automatic display and copying", () => {
	let container: HTMLDivElement;
	let root: Root;
	const clipboard = vi.fn(async () => {});
	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: clipboard },
		});
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		Reflect.deleteProperty(navigator, "clipboard");
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
	});
	it("shows content without a reveal click and copies that exact content rather than the GM order number", async () => {
		const content = "TEST-CARD\nhttps://redeem.example/use\n保留上游说明";
		const fetcher = vi.fn(async () =>
			Response.json({ content, usageUrl: "https://verified.example/redeem" }),
		);
		vi.stubGlobal("fetch", fetcher);
		await act(async () =>
			root.render(
				<DeliveryRevealContent
					deliveryId="delivery-test"
					orderNumber={orderNumber}
					email="buyer@example.com"
				/>,
			),
		);
		expect(container.textContent).toContain(content);
		expect(container.textContent).not.toContain(orderNumber);
		await act(async () =>
			container
				.querySelector<HTMLButtonElement>('button[aria-label="复制"]')
				?.click(),
		);
		expect(clipboard).toHaveBeenCalledWith(content);
		expect(
			container.querySelector('a[href="https://verified.example/redeem"]'),
		).not.toBeNull();
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
