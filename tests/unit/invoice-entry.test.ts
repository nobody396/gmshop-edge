import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canPreview, send } from "../../src/features/invoice/client";

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

it("preserves the backend business failure instead of exposing a Zod error", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json(
				{ status_code: 400, msg: "创建开票补款失败，请稍后重试", data: {} },
				{ status: 400 },
			),
		),
	);
	await expect(
		send({ action: "create", order_no: "TEST", invoice_amount: "685" }),
	).rejects.toThrow("创建开票补款失败，请稍后重试");
});

it("checks HTTP-200 business errors before decoding success data", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				status_code: 409,
				msg: "该订单已申请开票",
				data: { request_id: "test" },
			}),
		),
	);
	await expect(
		send({ action: "create", order_no: "TEST", invoice_amount: "685" }),
	).rejects.toThrow("该订单已申请开票");
});
it("does not expose schema internals for malformed success responses", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({ status_code: 0, msg: "success", data: {} }),
		),
	);
	await expect(
		send({ action: "create", order_no: "TEST", invoice_amount: "685" }),
	).rejects.not.toThrow("invalid_type");
});
it("does not expose a JSON parse error for gateway HTML failures", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () => new Response("<html>Bad gateway</html>", { status: 502 }),
		),
	);
	await expect(
		send({ action: "create", order_no: "TEST", invoice_amount: "685" }),
	).rejects.not.toThrow("JSON");
});

it("previews an order before the amount is entered so the service can prefill it", async () => {
	expect(
		canPreview({ order_no: "GM1", order_email: "", invoice_amount: "" }),
	).toBe(false);
	expect(
		canPreview({
			order_no: "GM1",
			order_email: "a@example.com",
			invoice_amount: "",
		}),
	).toBe(true);
	expect(
		canPreview({ order_no: "", order_email: "", invoice_amount: "" }),
	).toBe(false);
	expect(
		canPreview({ order_no: "", order_email: "", invoice_amount: "100" }),
	).toBe(true);
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({ data }),
	);
	vi.stubGlobal("fetch", fetch);
	await send({
		action: "preview",
		order_no: "GM1",
		order_email: "a@example.com",
		invoice_amount: "",
	});
	expect(fetch.mock.calls[0]?.[0]).toBe(
		"https://lsrai.shop/api/v1/guest/invoices/gmshop/preview",
	);
	expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
		order_no: "GM1",
		invoice_amount: "",
	});
});

it.each([
	"preview",
	"create",
])("forwards selected screenshot in %s and verifies server pricing", async (action) => {
	const selected = {
		...data,
		invoice_base_amount: "100.00",
		invoice_total_amount: "105.00",
		invoice_fee_amount: "3.15",
		consumption_screenshot: true,
		screenshot_fee_amount: "5.00",
		payment_fee_amount: "0.33",
		payment_amount: "8.48",
	};
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({ data: selected }),
	);
	vi.stubGlobal("fetch", fetch);
	expect(
		await send({ action, invoice_amount: "100", consumption_screenshot: true }),
	).toEqual(selected);
	expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
		consumption_screenshot: true,
		invoice_amount: "100",
		payment_method: "alipay",
	});
});
it("blocks a selected screenshot when an older backend ignores it", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ data })),
	);
	await expect(
		send({
			action: "preview",
			invoice_amount: "100",
			consumption_screenshot: true,
		}),
	).rejects.toThrow();
});
it("passes unchecked explicitly so revising an unpaid application can remove the fee", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({ data }),
	);
	vi.stubGlobal("fetch", fetch);
	await send({
		action: "create",
		invoice_amount: "100",
		consumption_screenshot: false,
	});
	expect(
		JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).consumption_screenshot,
	).toBe(false);
});

it("shows the three-business-day promise and order-amount label without changing pricing fields", () => {
	const zh = JSON.parse(
		readFileSync(new URL("../../messages/zh-CN.json", import.meta.url), "utf8"),
	);
	const en = JSON.parse(
		readFileSync(new URL("../../messages/en-US.json", import.meta.url), "utf8"),
	);
	expect(zh.invoice_intro).toBe(
		"在本网站填写资料并支付开票补款，三个工作日内完成",
	);
	expect(zh.invoice_base_amount).toBe("订单金额");
	expect(en.invoice_intro).toContain("within three business days");
	expect(en.invoice_base_amount).toBe("Order amount");
});
