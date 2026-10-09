import { describe, expect, it, vi } from "vitest";
import { epayPaymentProvider } from "#/features/shop-payments/providers/epay";

const input = {
	attemptId: "11111111-1111-4111-8111-111111111111",
	orderId: "22222222-2222-4222-8222-222222222222",
	orderNumber: "GMFIXTURE",
	amountMinor: "12500",
	currency: "CNY",
	currencyDecimals: 2,
	customerEmail: "buyer@example.com",
	description: "Fixture",
	successUrl: "https://shop.example/order?payment=return",
	cancelUrl: "https://shop.example/order",
	webhookUrl: "https://shop.example/webhook",
	defaultToken: "",
	defaultNetwork: "",
	payerIp: "2001:db8::10",
};
const credential = {
	baseUrl: "https://zpay.example",
	pid: "1000",
	secretKey: "fixture-sensitive-secret",
	paymentMethod: "alipay",
};

describe("EPay payment creation diagnostics", () => {
	it.each([
		[
			"HTTP",
			() => new Response("private upstream HTML", { status: 503 }),
			"payment_provider_http_error",
			{ httpStatus: 503 },
		],
		[
			"JSON",
			() => new Response("private upstream HTML"),
			"payment_provider_invalid_json",
			{ httpStatus: 200 },
		],
		[
			"shape",
			() => Response.json({ unrelated: "private" }),
			"payment_provider_invalid_response",
			{ httpStatus: 200 },
		],
		[
			"missing URL",
			() => Response.json({ code: 1, trade_no: "fixture" }),
			"payment_provider_missing_checkout",
			{ httpStatus: 200 },
		],
		[
			"invalid URL",
			() =>
				Response.json({
					code: 1,
					trade_no: "fixture",
					payurl: "https://[invalid",
				}),
			"payment_provider_invalid_checkout",
			{ httpStatus: 200 },
		],
	] as const)("distinguishes %s failures without exposing raw payloads", async (_, response, code, diagnostics) => {
		const fetcher = vi.fn(async () => response());
		await expect(
			epayPaymentProvider.createPayment(input, credential, fetcher),
		).rejects.toMatchObject({ code, diagnostics });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it.each([
		"TimeoutError",
		"TypeError",
	])("classifies %s without persisting its unsafe message", async (name) => {
		const error = new Error(credential.secretKey);
		error.name = name;
		const fetcher = vi.fn(async () => {
			throw error;
		});
		await expect(
			epayPaymentProvider.createPayment(input, credential, fetcher),
		).rejects.toMatchObject({
			code:
				name === "TimeoutError"
					? "payment_provider_timeout"
					: "payment_provider_network_error",
			diagnostics: {},
		});
	});

	it("retains a bounded refusal explanation but redacts echoed credentials, URLs and payer data", async () => {
		const fetcher = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
			const form = init?.body as FormData;
			return Response.json({
				code: "error",
				msg: `用户IP地址格式错误 ${credential.secretKey} ${encodeURIComponent(credential.secretKey)} ${form.get("sign")} ${credential.pid} ${input.payerIp} ${input.customerEmail} https://pay.example/?key=not-for-logs\n${"x".repeat(300)}`,
			});
		});
		const error = await epayPaymentProvider
			.createPayment(input, credential, fetcher)
			.catch((error) => error);
		expect(error.code).toBe("payment_provider_rejected");
		expect(error.diagnostics.providerMessage).toContain("用户IP地址格式错误");
		expect(error.diagnostics.providerMessage.length).toBeLessThanOrEqual(240);
		const serialized = JSON.stringify(error);
		for (const value of [
			credential.secretKey,
			credential.pid,
			input.payerIp,
			input.customerEmail,
			"not-for-logs",
			"https://pay.example/",
		])
			expect(serialized).not.toContain(value);
	});
});
