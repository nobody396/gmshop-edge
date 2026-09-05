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

	it("sets the honest expectation before linking to ChatGPT recharge", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => root?.render(<SelfServiceRecharge />));

		const text = container.textContent ?? "";
		expect(text).toContain("Automatic delivery, 24/7");
		expect(text).toContain("in as little as about 3 minutes");
		expect(text).toContain("recharge code and the matching recharge website");
		expect(text).toContain("provide only what that page requests");
		expect(text).toContain("extra verification");
		expect(text).not.toContain("no information required");
		expect(container.querySelectorAll("li")).toHaveLength(3);
		expect(container.querySelector("[data-self-service-recharge]")?.id).toBe(
			"self-service-recharge",
		);
		expect(container.querySelector("a")?.getAttribute("href")).toBe(
			"/products/2a794b89-3bb9-49d4-8691-0d13a1606869",
		);
	});

	it("is promoted above the fold with a reduced-motion-safe breathing action", () => {
		const home = readFileSync(
			join(process.cwd(), "src/features/home/index.tsx"),
			"utf8",
		);
		expect(home).toContain('href="#self-service-recharge"');
		expect(home).toContain("m.store_self_service_hero_action()");
		expect(home).toContain(
			"motion-safe:animate-[ping_2.4s_ease-in-out_infinite]",
		);
		expect(home).toContain("ring-2 ring-primary/50");
		expect(home).toContain("{hasFilters ? null : <SelfServiceRecharge />}");
	});
});
