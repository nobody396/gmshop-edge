// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	ClaudePurchaseGuide,
	claudeRechargeProductId,
} from "#/features/storefront/components/claude-purchase-guide";
import { overwriteGetLocale } from "#/paraglide/runtime";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	overwriteGetLocale(() => "zh-CN");
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

it("includes all three blockers, both checks, all three source images, all three normal examples and the IP recommendation", async () => {
	await act(async () => root.render(<ClaudePurchaseGuide />));
	for (const text of [
		"情况一",
		"情况二",
		"会导致本次充值的钱被拿去抵扣",
		"造成充值失败，且无法退款",
		"情况三",
		"对应的 organization ID 实际上已经被封禁",
		"这种情况属于隐性封禁，充值无法到账，并且无法退款",
		"方法一",
		"方法二",
		"90 分",
		"纯净度评分",
		"IP 风险分",
		"避免频繁切换节点",
		"手机、电脑和网页版都适用",
		"不是 Claude 官方标准",
		"不保证账号不会被封禁",
		"检测网页与实际客户端",
	]) {
		expect(container.textContent).toContain(text);
	}
	expect(container.textContent).toContain(
		"This organization has been disabled.",
	);
	expect(container.textContent).toContain(
		"Cannot start subscription for a banned organization",
	);
	const images = [...container.querySelectorAll("img")];
	expect(images).toHaveLength(6);
	for (const image of images) {
		expect(image.alt.length).toBeGreaterThan(0);
		const src = image.getAttribute("src");
		if (!src) throw new Error("Missing source image");
		const bytes = readFileSync(join(process.cwd(), `public${src}`));
		expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
	}
	const link = container.querySelector(
		'a[href="https://ip-check.leeguoo.com/"]',
	);
	expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
	expect(link?.getAttribute("referrerpolicy")).toBe("no-referrer");
	for (const href of [
		"https://claude.ai/",
		"https://claude.ai/upgrade?from=menu",
	]) {
		const anchor = container.querySelector(`a[href="${href}"]`);
		expect(anchor?.getAttribute("target")).toBe("_blank");
		expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
		expect(anchor?.getAttribute("referrerpolicy")).toBe("no-referrer");
	}
	expect(container.textContent).toContain("正常情况（示例）");
	expect(container.textContent).toContain("异常情况（不可充值）");
	expect(container.textContent).toContain("不需要在官网付款");
	expect(
		[...container.querySelectorAll("a")].map((anchor) => anchor.href),
	).toEqual([
		"https://ip-check.leeguoo.com/",
		"https://claude.ai/",
		"https://claude.ai/upgrade?from=menu",
	]);
	expect(container.textContent).toContain(
		"请先完成 IP 质检，再点击下方官网链接",
	);
	const methodOne = [...container.querySelectorAll("article")].find((article) =>
		article.querySelector("h4")?.textContent?.includes("方法一"),
	);
	expect(
		[...(methodOne?.querySelectorAll("img") ?? [])].map((image) =>
			image.getAttribute("src"),
		),
	).toEqual([
		"/guides/claude/message-normal.png",
		"/guides/claude/message-disabled.png",
	]);
	expect(container.querySelector("iframe")).toBeNull();
	expect(container.textContent).not.toContain("普通网络错误");
	expect(container.textContent).not.toContain("自查通过不代表以后不会封号");
	expect(container.textContent).toContain("以下三种情况，请不要下单。");
	expect(container.textContent).toContain("以上任一情况请先停止下单");
	expect(container.querySelector('a[href*="aisou.pro"]')).toBeNull();
});

it("opens source images in a dialog without navigation or submitting a purchase", async () => {
	await act(async () => root.render(<ClaudePurchaseGuide />));
	const trigger = container.querySelector("button");
	if (!trigger) throw new Error("Missing image trigger");
	expect(trigger.type).toBe("button");
	const url = location.href;
	trigger.focus();
	await act(async () => trigger.click());
	expect(
		document
			.querySelector('[data-slot="dialog-content"] img')
			?.getAttribute("src"),
	).toBe("/guides/claude/active-subscription.png");
	await act(async () =>
		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		),
	);
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
	expect(document.querySelector('[data-slot="dialog-content"]')).toBeNull();
	expect(document.activeElement).toBe(trigger);
	expect(location.href).toBe(url);
});

it("provides English copy while retaining the exact error examples and score direction", async () => {
	overwriteGetLocale(() => "en-US");
	await act(async () => root.render(<ClaudePurchaseGuide />));
	expect(container.textContent).toContain("Read before ordering Claude");
	expect(container.textContent).toContain("at least 90/100");
	expect(container.textContent).toContain("higher is better");
	expect(container.textContent).toContain("lower is better");
	expect(container.textContent).toContain("not an official Claude requirement");
	expect(container.querySelectorAll("img")).toHaveLength(6);
});

it("covers the shared Claude product across all SKUs and direct/mixed checkout", () => {
	expect(claudeRechargeProductId).toBe("ba540b83-388d-45d1-9dcb-25c3da3f9956");
	const product = readFileSync(
		join(process.cwd(), "src/features/storefront/pages/product.tsx"),
		"utf8",
	);
	const checkout = readFileSync(
		join(process.cwd(), "src/features/storefront/pages/checkout.tsx"),
		"utf8",
	);
	expect(product).toContain('href="#claude-purchase-guide"');
	expect(product).toContain(
		"data.id === claudeRechargeProductId ? <ClaudePurchaseGuide /> : null",
	);
	expect(checkout).toContain(
		"items.some((item) => item.productId === claudeRechargeProductId)",
	);
	expect(checkout).toContain("<ClaudePurchaseGuide />");
});

it("separates IP quality from purchase guidance and puts the IP section first", async () => {
	await act(async () => root.render(<ClaudePurchaseGuide />));
	expect([...container.children].map((element) => element.id)).toEqual([
		"claude-ip-check",
		"claude-purchase-guide",
	]);
	const ip = container.querySelector("#claude-ip-check");
	const purchase = container.querySelector("#claude-purchase-guide");
	expect(ip?.querySelector("h2")?.textContent).toContain("使用前先做 IP 质检");
	expect(purchase?.querySelector("h2")?.textContent).toContain(
		"Claude 下单必看",
	);
	expect(ip?.contains(purchase)).toBe(false);
	expect(purchase?.querySelector("[data-claude-ip-check]")).toBeNull();
	expect(purchase?.textContent).not.toContain("IP 纯净度评分");
	expect(purchase?.querySelectorAll("img")).toHaveLength(6);
});
