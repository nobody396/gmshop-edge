import { afterEach, describe, expect, it, vi } from "vitest";
import { send } from "../../src/features/invoice/client";

const data = {
	invoice_total_amount: "100.00",
	invoice_fee_amount: "3.00",
	payment_fee_amount: "0.12",
	payment_amount: "3.12",
};
afterEach(() => vi.unstubAllGlobals());
describe("independent VIP invoice API", () => {
	it("uses dedicated manual endpoint without cookies or preview identity fields", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ data }),
		);
		vi.stubGlobal("fetch", fetch);
		expect(
			await send({
				action: "preview",
				invoice_amount: "100",
				buyer_title: "PREVIEW ONLY",
			}),
		).toEqual(data);
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://lsrai.shop/api/v1/guest/invoices/gmshop/manual/preview",
		);
		expect(fetch.mock.calls[0]?.[1]?.credentials).toBe("omit");
		expect(fetch.mock.calls[0]?.[1]?.body).not.toContain("PREVIEW ONLY");
	});
	it("keeps order verification and Alipay payment on the existing service", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ data }),
		);
		vi.stubGlobal("fetch", fetch);
		await send({
			action: "create",
			order_no: "TEST",
			order_email: "buyer@example.com",
			invoice_amount: "100",
		});
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://lsrai.shop/api/v1/guest/invoices/gmshop",
		);
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
			order_no: "TEST",
			payment_method: "alipay",
		});
	});
	it("queries status without sending credentials", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ data }),
		);
		vi.stubGlobal("fetch", fetch);
		await send({ action: "status", request_no: "INV-TEST" });
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://lsrai.shop/api/v1/public/invoices/INV-TEST",
		);
		expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
	});
	it("rejects arbitrary status paths", async () => {
		await expect(
			send({ action: "status", request_no: "../settings" }),
		).rejects.toThrow();
	});
	it("shows service errors without claiming success", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ data: null, msg: "Unavailable" }, { status: 503 }),
			),
		);
		await expect(
			send({ action: "preview", invoice_amount: "100" }),
		).rejects.toThrow("Unavailable");
	});
});
