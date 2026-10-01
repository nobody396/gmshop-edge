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

	it("sets the honest expectation without adding a second jump action", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => root?.render(<SelfServiceRecharge />));

		const text = container.textContent ?? "";
		expect(text).toContain("Automatic delivery, 24/7");
		expect(text).toContain("in as little as about 3 minutes");
		expect(text).toContain("recharge code and the matching recharge website");
		expect(text).toContain("30-day subscription warranty");
		expect(text).toContain("Contact support directly");
		expect(text).toContain("provide only what that page requests");
		expect(text).not.toContain("no information required");
		expect(container.querySelectorAll("li")).toHaveLength(3);
		expect(container.querySelector("[data-self-service-recharge]")?.id).toBe(
			"self-service-recharge",
		);
		expect(container.querySelector("a")).toBeNull();
		expect(text).not.toContain("passwords");
		expect(text).toContain("Tell us about your account");
		expect(container.querySelectorAll("section")).toHaveLength(1);
		expect(container.textContent).toContain("Get started");
		expect(container.querySelectorAll("button")).toHaveLength(1);
		expect(
			container
				.querySelector("button")
				?.classList.contains("buying-guide-breathe"),
		).toBe(true);
	});

	it("keeps the full guide inline without a separate hero jump button", () => {
		const home = readFileSync(
			join(process.cwd(), "src/features/home/index.tsx"),
			"utf8",
		);
		expect(home).not.toContain('href="#self-service-recharge"');
		expect(home).not.toContain("store_self_service_hero_action");
		expect(home).not.toContain("store-recharge-breathe");
		expect(home).toContain("{hasFilters ? null : <SelfServiceRecharge />}");
		expect(home).not.toContain("<BuyingGuide");
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
