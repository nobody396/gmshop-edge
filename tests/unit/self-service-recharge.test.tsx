// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SelfServiceRecharge } from "#/features/home/self-service-recharge";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("homepage self-service recharge", () => {
	let root: ReturnType<typeof createRoot> | undefined;
	let container: HTMLDivElement | undefined;

	afterEach(async () => {
		await act(async () => root?.unmount());
		container?.remove();
		root = undefined;
		container = undefined;
	});

	it("collapses pre-order checks into one notice strip with the guide action", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => root?.render(<SelfServiceRecharge />));

		const text = container.textContent ?? "";
		expect(text).toContain("Read before ordering");
		expect(text).toContain("get your code on the order page");
		expect(text).not.toContain("Wrong purchases are not eligible");
		expect(text).not.toContain("Alipay");
		expect(text).not.toContain("USDT");
		expect(container.querySelectorAll("li")).toHaveLength(0);
		expect(container.querySelector("[data-self-service-recharge]")?.id).toBe(
			"self-service-recharge",
		);
		expect(container.querySelector("a")).toBeNull();
		expect(container.querySelectorAll("section")).toHaveLength(1);
		expect(container.querySelectorAll("button")).toHaveLength(1);
		expect(container.querySelector("button")?.textContent).toContain(
			"Not sure what to buy? Buying guide",
		);
		expect(
			container
				.querySelector("button")
				?.classList.contains("buying-guide-breathe"),
		).toBe(true);
	});

	it("keeps the guide inside the notice strip instead of a hero jump button", () => {
		const home = readFileSync(
			join(process.cwd(), "src/features/home/index.tsx"),
			"utf8",
		);
		expect(home).not.toContain('href="#self-service-recharge"');
		expect(home).toContain("{hasFilters ? null : <SelfServiceRecharge />}");
		expect(home).not.toContain("<BuyingGuide");
		expect(home).toContain("usePublicHeaderHeight()");
		expect(home).not.toMatch(/lg:sticky|lg:top-/);
	});
});

it("uses a motion-preference gated CSS breath without changing guide behavior", () => {
	const css = readFileSync("src/styles/global.css", "utf8");
	expect(css).toContain("@keyframes buying-guide-breathe");
	expect(css).toMatch(
		/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.buying-guide-breathe:not\(:hover\):not\(:focus-visible\):not\(\[data-state="open"\]\)/,
	);
	expect(css).toContain(
		"animation: buying-guide-breathe 2.8s ease-in-out infinite",
	);
});
