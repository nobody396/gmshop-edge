// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryMessage } from "#/features/storefront/components/delivery-message";
import { DeliveryRevealContent } from "#/features/storefront/components/delivery-reveal-content";
import { OrderDeliveryNotice } from "#/features/storefront/components/order-delivery-notice";
import {
	parseStructuredDelivery,
	splitDeliveryMessage,
} from "#/features/storefront/delivery-message";

vi.mock("#/paraglide/messages", () => ({
	m: {
		store_delivery_your_code: () => "你的卡密",
		store_delivery_copy_code: () => "复制卡密",
		store_delivery_copy_all: () => "复制全部",
		store_delivery_open_redeem: () => "去兑换页开通",
		store_delivery_redeem_hint: () => "粘贴上方卡密即可开通",
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
	fulfillmentSource: "manual" | "local",
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
		for (const source of ["local"] as const) {
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
	it("uses a public review flag without exposing supplier state", () => {
		const html = renderToString(
			<OrderDeliveryNotice
				deliveries={[{ ...delivery("local"), needsReview: true }]}
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
				deliveries={[delivery("local"), delivery("manual")]}
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
						delivery("local", "delivered"),
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
		const links = [...container.querySelectorAll("a")];
		// Primary redeem button, the verbatim redeem line, and the tutorial link.
		expect(links.map((link) => link.getAttribute("href"))).toEqual([
			"https://redeem.example/claude",
			"https://redeem.example/claude",
			"https://guide.example/claude",
		]);
		for (const link of links) {
			expect(link.rel).toBe("noopener noreferrer");
			expect(link.target).toBe("_blank");
			expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
		}
		for (const line of content.split("\n").filter(Boolean))
			expect(container.textContent).toContain(line);
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
				.querySelector<HTMLButtonElement>('button[aria-label="复制全部"]')
				?.click(),
		);
		expect(clipboard).toHaveBeenCalledWith(content);
		expect(
			container.querySelector('a[href="https://verified.example/redeem"]'),
		).not.toBeNull();
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("copies only the card code, confirms in the label and still tracks the copy", async () => {
		const content =
			"CDK：gpt-5x-ios-8VAP-6XS7-MXR8-673X\n充值地址：https://redeem.lsrai.shop";
		const onCopy = vi.fn();
		await act(async () =>
			root.render(<DeliveryMessage content={content} onCopy={onCopy} />),
		);
		const button = container.querySelector<HTMLButtonElement>(
			'button[aria-label="复制卡密"]',
		);
		expect(button?.textContent).toContain("复制卡密");
		await act(async () => button?.click());
		expect(clipboard).toHaveBeenCalledWith("gpt-5x-ios-8VAP-6XS7-MXR8-673X");
		expect(onCopy).toHaveBeenCalledTimes(1);
		expect(button?.textContent).toContain("已复制");
		const redeem = [...container.querySelectorAll("a")].find((link) =>
			link.textContent?.includes("去兑换页开通"),
		);
		expect(redeem?.getAttribute("href")).toBe("https://redeem.lsrai.shop/");
		expect(redeem?.target).toBe("_blank");
		expect(container.querySelector("[data-delivery-code]")?.innerHTML).toBe(
			"gpt-<wbr>5x-<wbr>ios-<wbr>8VAP-<wbr>6XS7-<wbr>MXR8-<wbr>673X",
		);
	});

	it("lists several codes with their own copy buttons plus copy all", async () => {
		const content =
			"CDK：AAAA-1111\nCDK：BBBB-2222\n充值地址：https://redeem.example";
		await act(async () => root.render(<DeliveryMessage content={content} />));
		const codeButtons = container.querySelectorAll<HTMLButtonElement>(
			'button[aria-label="复制卡密"]',
		);
		expect(codeButtons).toHaveLength(2);
		await act(async () => codeButtons[1]?.click());
		expect(clipboard).toHaveBeenLastCalledWith("BBBB-2222");
		await act(async () =>
			container
				.querySelector<HTMLButtonElement>('button[aria-label="复制全部"]')
				?.click(),
		);
		expect(clipboard).toHaveBeenLastCalledWith("AAAA-1111\nBBBB-2222");
	});
});

describe("structured delivery parsing", () => {
	it.each([
		[
			"CDK：gpt-5x-ios-8VAP-6XS7-MXR8-673X",
			"CDK：",
			"gpt-5x-ios-8VAP-6XS7-MXR8-673X",
		],
		["CDK: ABCD-EFGH", "CDK:", "ABCD-EFGH"],
		["cdk : ABCD-EFGH ", "cdk :", "ABCD-EFGH"],
		["卡密：XYZ123456", "卡密：", "XYZ123456"],
		["兑换码:XYZ123456", "兑换码:", "XYZ123456"],
		["  卡密2：XYZ123456", "卡密2：", "XYZ123456"],
	])("recognises %j as a card code", (line, label, value) => {
		expect(parseStructuredDelivery(line)?.codes).toEqual([{ label, value }]);
	});

	it("separates the code, the labelled redeem URL and the remaining lines", () => {
		const parsed = parseStructuredDelivery(
			"CDK：AAAA-1111\r\n充值地址：https://redeem.example/x。\r\n\r\n教程：https://guide.example\r\n",
		);
		expect(parsed?.codes).toEqual([{ label: "CDK：", value: "AAAA-1111" }]);
		expect(parsed?.redeem).toEqual({
			href: "https://redeem.example/x",
			line: "充值地址：https://redeem.example/x。",
		});
		expect(parsed?.rest).toBe("教程：https://guide.example");
	});

	it("recognises 兑换地址 and 兑换页 lines and falls back to a verified usageUrl", () => {
		expect(
			parseStructuredDelivery("卡密：AAAA1111\n兑换地址：https://a.example")
				?.redeem?.href,
		).toBe("https://a.example/");
		expect(
			parseStructuredDelivery("卡密：AAAA1111\n兑换页：https://b.example")
				?.redeem?.href,
		).toBe("https://b.example/");
		expect(
			parseStructuredDelivery("卡密：AAAA1111", "https://c.example/redeem")
				?.redeem,
		).toEqual({ href: "https://c.example/redeem", line: null });
		expect(
			parseStructuredDelivery("卡密：AAAA1111", "javascript:alert(1)")?.redeem,
		).toBeNull();
	});

	it("keeps several codes in order", () => {
		expect(
			parseStructuredDelivery(
				"CDK：A-1111\nCDK：B-2222\nCDK：C-3333",
			)?.codes.map((code) => code.value),
		).toEqual(["A-1111", "B-2222", "C-3333"]);
	});

	it.each([
		"user@example.com----password123",
		"https://gift.example/claim/abc",
		"TEST-CARD",
		"卡密：two words here",
		"CDK：https://not-a-code.example",
		"请联系客服领取",
	])("does not recognise %j", (content) => {
		expect(parseStructuredDelivery(content)).toBeNull();
	});

	it("renders unrecognised content raw with a labelled copy-all button and every character", () => {
		const content =
			"账号：user@example.com----password123\n备注：首次登录请改密";
		const container = document.createElement("div");
		container.innerHTML = renderToString(<DeliveryMessage content={content} />);
		expect(
			container
				.querySelector("[data-delivery-content]")
				?.getAttribute("data-delivery-layout"),
		).toBe("raw");
		expect(container.textContent).toContain(content);
		expect(
			container.querySelector('button[aria-label="复制全部"]')?.textContent,
		).toContain("复制全部");
	});

	it("never drops a visible character from structured content", () => {
		const content =
			"CDK：AAAA-1111\nCDK：BBBB-2222\n充值地址：https://redeem.example/a?b=1\n说明：24 小时内有效\n教程 https://guide.example";
		const container = document.createElement("div");
		container.innerHTML = renderToString(<DeliveryMessage content={content} />);
		const shown = (container.textContent ?? "").replace(/\s/g, "");
		for (const line of content.split("\n"))
			expect(shown).toContain(line.replace(/\s/g, ""));
	});
});
