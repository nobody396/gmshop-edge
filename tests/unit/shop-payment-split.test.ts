import { describe, expect, it, vi } from "vitest";
import { createAlipayQrProvider } from "#/features/shop-payments/providers/alipay";
import {
	bytesToBase64,
	rsaSha256Sign,
	rsaSha256Verify,
} from "#/features/shop-payments/providers/rsa";
import { paymentChannelInputSchema } from "#/features/shop-payments/schema";
import {
	beijingDayStart,
	paymentLimitDecision,
	splitOrderExpiry,
	splitPaymentAmount,
} from "#/features/shop-payments/split";

describe("split payment amounts", () => {
	it("splits into ceil(amount / cap) parts as even as possible in cents", () => {
		expect(splitPaymentAmount("300000", "200000")).toEqual([
			"150000",
			"150000",
		]);
		expect(splitPaymentAmount("400100", "200000")).toEqual([
			"133367",
			"133367",
			"133366",
		]);
		expect(splitPaymentAmount("200000", "200000")).toEqual(["200000"]);
		expect(splitPaymentAmount("200001", "200000")).toEqual([
			"100001",
			"100000",
		]);
		for (const [amount, cap] of [
			["999999", "200000"],
			["1234567", "33333"],
			["5", "2"],
		] as const) {
			const parts = splitPaymentAmount(amount, cap);
			expect(parts.reduce((sum, part) => sum + BigInt(part), 0n)).toBe(
				BigInt(amount),
			);
			expect(parts.every((part) => BigInt(part) <= BigInt(cap))).toBe(true);
			const values = parts.map(BigInt);
			expect(
				values.reduce((max, value) => (value > max ? value : max)) -
					values.reduce((min, value) => (value < min ? value : min)),
			).toBeLessThanOrEqual(1n);
		}
	});

	it("decides whether a channel can take an amount", () => {
		const limits = {
			perPaymentMaxMinor: "200000",
			splitEnabled: true,
			splitMaxParts: 3,
			dailyRemainingMinor: null,
		};
		expect(paymentLimitDecision(limits, "200000")).toEqual({
			allowed: true,
			parts: 1,
		});
		expect(paymentLimitDecision(limits, "300000")).toEqual({
			allowed: true,
			parts: 2,
		});
		expect(paymentLimitDecision(limits, "600001")).toEqual({
			allowed: false,
			reason: "split_parts_limit",
		});
		expect(
			paymentLimitDecision({ ...limits, splitEnabled: false }, "300000"),
		).toEqual({ allowed: false, reason: "per_payment_limit" });
		expect(
			paymentLimitDecision(limits, "300000", { allowSplit: false }),
		).toEqual({ allowed: false, reason: "per_payment_limit" });
		expect(
			paymentLimitDecision(
				{ ...limits, dailyRemainingMinor: "299999" },
				"300000",
			),
		).toEqual({ allowed: false, reason: "daily_limit" });
		expect(
			paymentLimitDecision({ ...limits, perPaymentMaxMinor: "0" }, "9999999"),
		).toEqual({ allowed: true, parts: 1 });
	});

	it("uses the Beijing calendar day and gives split orders more time", () => {
		// 2026-11-11 15:59:59 UTC = 2026-11-11 23:59:59 Beijing.
		const lateEvening = Date.UTC(2026, 10, 11, 15, 59, 59);
		expect(beijingDayStart(lateEvening)).toBe(Date.UTC(2026, 10, 10, 16));
		// 2026-11-11 16:00:00 UTC = 2026-11-12 00:00 Beijing: a new day.
		expect(beijingDayStart(lateEvening + 1_000)).toBe(
			Date.UTC(2026, 10, 11, 16),
		);
		const now = 1_000_000_000;
		expect(splitOrderExpiry(now + 900_000, 2, now)).toBe(now + 1_800_000);
		expect(splitOrderExpiry(now + 900_000, 20, now)).toBe(now + 7_200_000);
		expect(splitOrderExpiry(now + 9_000_000, 2, now)).toBe(now + 9_000_000);
	});
});

describe("Alipay order QR (precreate)", () => {
	it("signs alipay.trade.precreate and returns the verified qr_code", async () => {
		const merchant = await rsaPair();
		const alipay = await rsaPair();
		const credential = {
			appId: "2026000000000001",
			sellerId: "2088000000000001",
			privateKeyPem: merchant.privateKeyPem,
			alipayPublicKeyPem: alipay.publicKeyPem,
		};
		const now = Date.now();
		let sent: Record<string, string> = {};
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				sent = Object.fromEntries(new URLSearchParams(String(init?.body)));
				return signedResponse(
					alipay.privateKeyPem,
					"alipay_trade_precreate_response",
					{
						code: "10000",
						msg: "Success",
						out_trade_no: "11111111111141118111111111111111",
						qr_code: "https://qr.alipay.com/bax01234567890",
					},
				);
			},
		);
		const created = await createAlipayQrProvider().createPayment(
			paymentInput({ expiresAt: now + 10 * 60_000 + 30_000 }),
			credential,
			fetcher as unknown as typeof fetch,
		);
		expect(created).toMatchObject({
			providerPaymentId: "11111111111141118111111111111111",
			checkoutUrl: "https://qr.alipay.com/bax01234567890",
		});
		expect(created.expiresAt).toBeLessThanOrEqual(now + 10 * 60_000 + 30_000);
		expect(createAlipayQrProvider().checkoutPresentation).toBe("qr");
		const { sign: signature = "", ...parameters } = sent;
		expect(
			await rsaSha256Verify(
				merchant.publicKeyPem,
				canonical(parameters),
				signature,
			),
		).toBe(true);
		expect(parameters.method).toBe("alipay.trade.precreate");
		expect(parameters.notify_url).toBe(
			"https://shop.example/api/shop/payments/channel/webhook",
		);
		const business = JSON.parse(parameters.biz_content ?? "{}");
		expect(business).toMatchObject({
			out_trade_no: "11111111111141118111111111111111",
			total_amount: "1500",
			product_code: "QR_CODE_OFFLINE",
		});
		// Rounded down to whole minutes so the QR closes before the order.
		expect(business.timeout_express).toMatch(/^(9|10)m$/);
	});

	it("rejects unsigned, refused, or foreign QR responses", async () => {
		const merchant = await rsaPair();
		const alipay = await rsaPair();
		const credential = {
			appId: "2026000000000001",
			sellerId: "2088000000000001",
			privateKeyPem: merchant.privateKeyPem,
			alipayPublicKeyPem: alipay.publicKeyPem,
		};
		const input = paymentInput({ expiresAt: Date.now() + 15 * 60_000 });
		await expect(
			createAlipayQrProvider().createPayment(input, credential, (async () =>
				signedResponse(
					alipay.privateKeyPem,
					"alipay_trade_precreate_response",
					{
						code: "40004",
						msg: "Business Failed",
						sub_code: "ACQ.ACCESS_FORBIDDEN",
					},
				)) as unknown as typeof fetch),
		).rejects.toMatchObject({ code: "payment_provider_rejected" });
		await expect(
			createAlipayQrProvider().createPayment(input, credential, (async () =>
				signedResponse(
					alipay.privateKeyPem,
					"alipay_trade_precreate_response",
					{
						code: "10000",
						qr_code: "https://evil.example/qr",
					},
				)) as unknown as typeof fetch),
		).rejects.toMatchObject({ code: "payment_provider_rejected" });
		const forged = await rsaPair();
		await expect(
			createAlipayQrProvider().createPayment(input, credential, (async () =>
				signedResponse(
					forged.privateKeyPem,
					"alipay_trade_precreate_response",
					{
						code: "10000",
						qr_code: "https://qr.alipay.com/bax0",
					},
				)) as unknown as typeof fetch),
		).rejects.toMatchObject({ code: "invalid_payment_signature" });
		await expect(
			createAlipayQrProvider().createPayment(
				paymentInput({ expiresAt: Date.now() + 30_000 }),
				credential,
				vi.fn() as unknown as typeof fetch,
			),
		).rejects.toMatchObject({ code: "order_not_payable" });
	});
});

describe("Alipay QR channel settings", () => {
	const base = {
		provider: "alipay_qr" as const,
		name: "支付宝",
		currency: "CNY",
		feeBps: 60,
		fixedFeeMinor: "0",
		sortOrder: 100,
		enabled: true,
		alipayAppId: "2026000000000001",
		alipaySellerId: "2088000000000001",
		alipayPrivateKeyPem: "-----BEGIN PRIVATE KEY-----x",
		alipayPublicKeyPem: "-----BEGIN PUBLIC KEY-----x",
	};

	it("accepts limits and split settings", () => {
		const parsed = paymentChannelInputSchema.parse({
			...base,
			splitEnabled: true,
			perPaymentMaxMinor: "200000",
			dailyMaxMinor: "2000000",
			splitMaxParts: 5,
		});
		expect(parsed).toMatchObject({
			splitEnabled: true,
			perPaymentMaxMinor: "200000",
			dailyMaxMinor: "2000000",
			splitMaxParts: 5,
		});
		expect(paymentChannelInputSchema.parse(base)).toMatchObject({
			splitEnabled: false,
			perPaymentMaxMinor: "0",
			dailyMaxMinor: "0",
			splitMaxParts: 10,
		});
	});

	it("rejects inconsistent limits", () => {
		const issues = (input: Record<string, unknown>) =>
			paymentChannelInputSchema
				.safeParse({ ...base, ...input })
				.error?.issues.map((issue) => issue.path[0]);
		expect(issues({ splitEnabled: true, perPaymentMaxMinor: "0" })).toEqual([
			"perPaymentMaxMinor",
		]);
		expect(
			issues({ perPaymentMaxMinor: "200000", dailyMaxMinor: "100000" }),
		).toEqual(["dailyMaxMinor"]);
		expect(issues({ perPaymentMaxMinor: "invalid" })).toEqual([
			"perPaymentMaxMinor",
		]);
		expect(issues({ splitMaxParts: 1 })).toEqual(["splitMaxParts"]);
		expect(issues({ currency: "USD" })).toEqual(["currency"]);
	});
});

function paymentInput(overrides: { expiresAt?: number } = {}) {
	return {
		attemptId: "11111111-1111-4111-8111-111111111111",
		orderId: "22222222-2222-4222-8222-222222222222",
		orderNumber: "GM100001",
		amountMinor: "150000",
		currency: "CNY",
		currencyDecimals: 2,
		customerEmail: "buyer@example.com",
		description: "Order GM100001",
		successUrl: "https://shop.example/orders/GM100001",
		cancelUrl: "https://shop.example/orders/GM100001",
		webhookUrl: "https://shop.example/api/shop/payments/channel/webhook",
		defaultToken: "",
		defaultNetwork: "",
		payerIp: null,
		...overrides,
	};
}

async function signedResponse(
	privateKeyPem: string,
	key: string,
	node: Record<string, unknown>,
) {
	const text = JSON.stringify(node);
	const sign = await rsaSha256Sign(privateKeyPem, text);
	return new Response(`{"${key}":${text},"sign":${JSON.stringify(sign)}}`);
}

function canonical(parameters: Record<string, string>) {
	return Object.entries(parameters)
		.filter(([key, value]) => value !== "" && key !== "sign")
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
}

async function rsaPair() {
	const pair = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	return {
		privateKeyPem: pem(
			"PRIVATE KEY",
			new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
		),
		publicKeyPem: pem(
			"PUBLIC KEY",
			new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
		),
	};
}

function pem(label: string, bytes: Uint8Array) {
	const base64 = bytesToBase64(bytes);
	return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----`;
}
