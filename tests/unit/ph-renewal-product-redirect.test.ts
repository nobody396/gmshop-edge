import { describe, expect, it, vi } from "vitest";

const { capture, redirect } = vi.hoisted(() => ({
	capture: vi.fn(),
	redirect: vi.fn((options: unknown) => options),
}));
vi.mock("@tanstack/react-router", () => ({
	createFileRoute: () => capture,
	redirect,
}));
vi.mock("#/features/storefront/pages/product", () => ({
	StorefrontProductPage: () => null,
}));
await import("../../src/routes/(public)/products/$productId");

const routeCall = capture.mock.calls[0];
if (!routeCall) throw new Error("Product route was not registered");
const { beforeLoad } = routeCall[0];
describe("legacy Philippines renewal product", () => {
	it("redirects to the existing renewal SKU on the shared ChatGPT product", () => {
		expect(() =>
			beforeLoad({
				params: { productId: "aa277f98-79b4-58cb-8b7b-1424fe930ab9" },
			}),
		).toThrow();
		expect(redirect).toHaveBeenCalledWith({
			to: "/products/$productId",
			params: { productId: "2a794b89-3bb9-49d4-8691-0d13a1606869" },
			search: { item: "624bf652-debb-48f4-ab98-6b9daab2a6ea" },
			hash: "purchase-options",
			replace: true,
		});
	});
	it("leaves all other products unchanged, without a redirect loop", () => {
		redirect.mockClear();
		for (const productId of [
			"2a794b89-3bb9-49d4-8691-0d13a1606869",
			"unrelated",
		])
			expect(beforeLoad({ params: { productId } })).toBeUndefined();
		expect(redirect).not.toHaveBeenCalled();
	});
});
