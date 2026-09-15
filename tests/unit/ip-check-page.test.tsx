// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IpCheckPage } from "#/features/ip-check/page";
import { overwriteGetLocale } from "#/paraglide/runtime";

let container: HTMLDivElement;
let root: Root;
const data = {
	ip: "203.0.113.10",
	country: "US",
	city: "Example",
	asn: 12345,
	organization: "Example Network",
	colo: "LAX",
	region: "listed",
	hosting: "unknown",
	status: "limited",
};
beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	overwriteGetLocale(() => "zh-CN");
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});
it.each([
	"zh-CN",
	"en-US",
] as const)("renders %s, masks IP and performs only the same-origin check by default", async (locale) => {
	overwriteGetLocale(() => locale);
	await act(async () => root.render(<IpCheckPage />));
	expect(container.textContent).toContain("203.•••.•••.10");
	expect(container.textContent).not.toContain("203.0.113.10");
	expect(container.querySelectorAll("article")).toHaveLength(5);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch).toHaveBeenCalledWith(
		"/api/ip-check",
		expect.objectContaining({ cache: "no-store" }),
	);
	const reveal = container.querySelector<HTMLButtonElement>(
		"button[aria-pressed]",
	);
	await act(async () => reveal?.click());
	expect(container.textContent).toContain("203.0.113.10");
	await act(async () => reveal?.click());
	expect(container.textContent).not.toContain("203.0.113.10");
	expect(container.querySelector('a[href*="leeguoo"]')).toBeNull();
});
it("failed check is visible and retry recovers without retaining old data", async () => {
	vi.mocked(fetch).mockRejectedValueOnce(new Error("offline"));
	await act(async () => root.render(<IpCheckPage />));
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"检测未完成",
	);
	const retry = [...container.querySelectorAll("button")].find((b) =>
		b.textContent?.includes("重新检测"),
	);
	await act(async () => retry?.click());
	expect(container.textContent).toContain("基础检查完成");
	expect(container.querySelector('[role="alert"]')).toBeNull();
});
it("loading never displays a successful verdict", async () => {
	vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
	await act(async () => root.render(<IpCheckPage />));
	expect(container.textContent).toContain("正在检测");
	expect(container.textContent).not.toContain("基础检查完成");
	expect(container.querySelector('section[aria-busy="true"]')).not.toBeNull();
});
it("invalid JSON shape becomes a recoverable error rather than a fabricated verdict", async () => {
	vi.mocked(fetch).mockResolvedValue(
		Response.json({ status: "safe", score: 100 }),
	);
	await act(async () => root.render(<IpCheckPage />));
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"检测未完成",
	);
});
