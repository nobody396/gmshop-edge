import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/db.server", () => ({ getEnv: () => ({ DB: {} }) }));
vi.mock("#/server/rate-limit", () => ({
	claimFixedWindowRateLimit: async () => ({ allowed: true }),
}));

import { invoiceRequest } from "../../src/features/invoice/server";

const req = (data: unknown, origin = "https://laoshirenvip.com") =>
	new Request("https://laoshirenvip.com/api/shop/invoice", {
		method: "POST",
		headers: { origin, "content-type": "application/json" },
		body: JSON.stringify(data),
	});
afterEach(() => vi.unstubAllGlobals());
describe("independent invoice intake", () => {
	it("rejects cross-site writes before upstream access", async () => {
		expect(
			(await invoiceRequest(req({ action: "create" }, "https://evil.example")))
				.status,
		).toBe(403);
	});
	it("rejects oversized bodies", async () => {
		expect(
			(
				await invoiceRequest(
					req({ action: "preview", buyer_title: "x".repeat(9000) }),
				)
			).status,
		).toBe(413);
	});
	it("uses dedicated VIP manual endpoint and never forwards auth or client-selected source", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ data: {} }),
		);
		vi.stubGlobal("fetch", fetch);
		await invoiceRequest(
			req({
				action: "preview",
				invoice_amount: "100",
				source_host: "evil.example",
			}),
		);
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://lsrai.shop/api/v1/guest/invoices/gmshop/manual/preview",
		);
		expect(JSON.stringify(fetch.mock.calls)).not.toContain("evil.example");
	});
	it("uses order-verified endpoint for a VIP order", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ data: {} }),
		);
		vi.stubGlobal("fetch", fetch);
		await invoiceRequest(
			req({
				action: "preview",
				order_no: "TEST",
				order_email: "buyer@example.com",
				invoice_amount: "100",
			}),
		);
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://lsrai.shop/api/v1/guest/invoices/gmshop/preview",
		);
	});
	it("rejects arbitrary status paths", async () => {
		expect(
			(
				await invoiceRequest(
					req({ action: "status", request_no: "../settings" }),
				)
			).status,
		).toBe(400);
	});
});
