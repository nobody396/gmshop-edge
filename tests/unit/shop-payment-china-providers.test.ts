import { describe, expect, it, vi } from "vitest";
import {
	createAlipayProvider,
	createAutomaticAlipayProvider,
} from "#/features/shop-payments/providers/alipay";
import {
	bytesToBase64,
	rsaSha256Sign,
	rsaSha256Verify,
} from "#/features/shop-payments/providers/rsa";
import {
	createAutomaticWechatPayProvider,
	createWechatPayProvider,
} from "#/features/shop-payments/providers/wechatpay";

describe("China payment providers", () => {
	it("creates signed Alipay desktop and mobile Web checkout URLs", async () => {
		const merchant = await rsaPair();
		const credential = {
			appId: "2026000000000001",
			sellerId: "2088000000000001",
			privateKeyPem: merchant.privateKeyPem,
			alipayPublicKeyPem: merchant.publicKeyPem,
		};
		for (const [mode, productCode] of [
			["FAST_INSTANT_TRADE_PAY", "FAST_INSTANT_TRADE_PAY"],
			["QUICK_WAP_WAY", "QUICK_WAP_WAY"],
		] as const) {
			const created = await createAlipayProvider(mode).createPayment(
				paymentInput(),
				credential,
			);
			const url = new URL(created.checkoutUrl);
			const parameters = Object.fromEntries(url.searchParams);
			const signature = parameters.sign ?? "";
			delete parameters.sign;
			expect(JSON.parse(parameters.biz_content ?? "{}")).toMatchObject({
				out_trade_no: "11111111111141118111111111111111",
				total_amount: "123.45",
				product_code: productCode,
			});
			expect(
				await rsaSha256Verify(
					merchant.publicKeyPem,
					canonical(parameters),
					signature,
				),
			).toBe(true);
		}
	});

	it("selects the Alipay checkout product from the customer device", async () => {
		const merchant = await rsaPair();
		const credential = {
			appId: "2026000000000001",
			sellerId: "2088000000000001",
			privateKeyPem: merchant.privateKeyPem,
			alipayPublicKeyPem: merchant.publicKeyPem,
		};
		const provider = createAutomaticAlipayProvider();
		for (const [payerMobile, productCode] of [
			[false, "FAST_INSTANT_TRADE_PAY"],
			[true, "QUICK_WAP_WAY"],
		] as const) {
			const payment = await provider.createPayment(
				paymentInput({ payerMobile }),
				credential,
			);
			const business = JSON.parse(
				new URL(payment.checkoutUrl).searchParams.get("biz_content") ?? "{}",
			);
			expect(business.product_code).toBe(productCode);
		}
	});

	it("verifies signed Alipay callbacks and preserves integer CNY amounts", async () => {
		const merchant = await rsaPair();
		const alipay = await rsaPair();
		const credential = {
			appId: "2026000000000001",
			sellerId: "2088000000000001",
			privateKeyPem: merchant.privateKeyPem,
			alipayPublicKeyPem: alipay.publicKeyPem,
		};
		const parameters: Record<string, string> = {
			notify_id: "notify-1",
			app_id: credential.appId,
			seller_id: credential.sellerId,
			trade_no: "2026072400000000000001",
			out_trade_no: "11111111111141118111111111111111",
			trade_status: "TRADE_SUCCESS",
			total_amount: "123.45",
			sign_type: "RSA2",
		};
		parameters.sign = await rsaSha256Sign(
			alipay.privateKeyPem,
			canonical(parameters, new Set(["sign", "sign_type"])),
		);
		await expect(
			createAlipayProvider("FAST_INSTANT_TRADE_PAY").parseWebhook(
				new Request("https://shop.example/webhook", {
					method: "POST",
					body: new URLSearchParams(parameters),
				}),
				credential,
			),
		).resolves.toMatchObject({
			providerEventId: "alipay:notify-1",
			providerPaymentId: "11111111111141118111111111111111",
			amountMinor: "12345",
			currency: "CNY",
			type: "payment_succeeded",
		});
	});

	it("verifies Alipay API responses against the exact signed response node", async () => {
		const merchant = await rsaPair();
		const alipay = await rsaPair();
		const credential = {
			appId: "2026000000000001",
			sellerId: "2088000000000001",
			privateKeyPem: merchant.privateKeyPem,
			alipayPublicKeyPem: alipay.publicKeyPem,
		};
		const responseNode =
			'{"code":"10000","msg":"Success","trade_no":"2026072400000000000001","out_trade_no":"11111111111141118111111111111111","trade_status":"TRADE_SUCCESS","total_amount":"123.45","sub_msg":"\\u652f\\u4ed8\\u6210\\u529f"}';
		const sign = await rsaSha256Sign(alipay.privateKeyPem, responseNode);
		const fetcher = vi.fn(
			async () =>
				new Response(
					`{"alipay_trade_query_response":${responseNode},"sign":${JSON.stringify(sign)}}`,
				),
		);

		await expect(
			createAlipayProvider("FAST_INSTANT_TRADE_PAY").queryPayment(
				"11111111111141118111111111111111",
				credential,
				fetcher,
			),
		).resolves.toEqual({
			status: "succeeded",
			amountMinor: "12345",
			currency: "CNY",
			providerTradeNo: "2026072400000000000001",
		});
	});

	it("creates signed WeChat Native and H5 transactions", async () => {
		const merchant = await rsaPair();
		const platform = await rsaPair();
		const credential = wechatCredential(merchant, platform);
		const nativeFetcher = signedWechatFetcher(
			platform.privateKeyPem,
			{ code_url: "weixin://wxpay/bizpayurl?pr=fixture123" },
			(input, init) => {
				expect(String(input)).toContain("/v3/pay/transactions/native");
				expect(new Headers(init?.headers).get("authorization")).toContain(
					'serial_no="A1B2C3"',
				);
			},
		);
		await expect(
			createWechatPayProvider("native").createPayment(
				paymentInput(),
				credential,
				nativeFetcher,
			),
		).resolves.toMatchObject({
			providerPaymentId: "11111111111141118111111111111111",
			checkoutUrl: "weixin://wxpay/bizpayurl?pr=fixture123",
		});

		const h5Fetcher = signedWechatFetcher(
			platform.privateKeyPem,
			{ h5_url: "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb" },
			(_input, init) => {
				expect(JSON.parse(String(init?.body))).toMatchObject({
					scene_info: {
						payer_client_ip: "203.0.113.10",
						h5_info: { type: "Wap" },
					},
				});
			},
		);
		await expect(
			createWechatPayProvider("h5").createPayment(
				paymentInput({ payerIp: "203.0.113.10" }),
				credential,
				h5Fetcher,
			),
		).resolves.toMatchObject({
			checkoutUrl: "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb",
		});
	});

	it("selects WeChat Native or H5 from the customer device", async () => {
		const merchant = await rsaPair();
		const platform = await rsaPair();
		const credential = wechatCredential(merchant, platform);
		const provider = createAutomaticWechatPayProvider();
		for (const [payerMobile, path, response] of [
			[
				false,
				"/v3/pay/transactions/native",
				{ code_url: "weixin://wxpay/bizpayurl?pr=automatic" },
			],
			[
				true,
				"/v3/pay/transactions/h5",
				{ h5_url: "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb" },
			],
		] as const) {
			const fetcher = signedWechatFetcher(
				platform.privateKeyPem,
				response,
				(input) => expect(String(input)).toContain(path),
			);
			await provider.createPayment(
				paymentInput({
					payerMobile,
					payerIp: payerMobile ? "203.0.113.10" : null,
				}),
				credential,
				fetcher,
			);
		}
	});

	it("verifies and decrypts WeChat APIv3 payment notifications", async () => {
		const merchant = await rsaPair();
		const platform = await rsaPair();
		const credential = wechatCredential(merchant, platform);
		const resource = await encryptWechatResource(
			{
				appid: credential.appId,
				mchid: credential.mchId,
				out_trade_no: "11111111111141118111111111111111",
				transaction_id: "4200000000202607240000000001",
				trade_state: "SUCCESS",
				amount: { total: 12345, currency: "CNY" },
			},
			credential.apiV3Key,
		);
		const body = JSON.stringify({
			id: "wechat-event-1",
			event_type: "TRANSACTION.SUCCESS",
			resource,
		});
		const headers = await signedWechatHeaders(platform.privateKeyPem, body);
		await expect(
			createWechatPayProvider("native").parseWebhook(
				new Request("https://shop.example/webhook", {
					method: "POST",
					headers,
					body,
				}),
				credential,
			),
		).resolves.toMatchObject({
			providerEventId: "wechat-event-1",
			providerPaymentId: "11111111111141118111111111111111",
			amountMinor: "12345",
			currency: "CNY",
			type: "payment_succeeded",
		});
	});
});

function canonical(
	parameters: Record<string, string>,
	excluded = new Set(["sign"]),
) {
	return Object.entries(parameters)
		.filter(([key, value]) => value !== "" && !excluded.has(key))
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

function wechatCredential(
	merchant: Awaited<ReturnType<typeof rsaPair>>,
	platform: Awaited<ReturnType<typeof rsaPair>>,
) {
	return {
		appId: "wx1234567890abcdef",
		mchId: "1900000109",
		merchantSerialNumber: "A1B2C3",
		merchantPrivateKeyPem: merchant.privateKeyPem,
		apiV3Key: "12345678901234567890123456789012",
		platformSerialNumber: "D4E5F6",
		platformPublicKeyPem: platform.publicKeyPem,
	};
}

function signedWechatFetcher(
	platformPrivateKey: string,
	payload: unknown,
	assertRequest: (input: RequestInfo | URL, init?: RequestInit) => void,
) {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		assertRequest(input, init);
		const body = JSON.stringify(payload);
		return new Response(body, {
			headers: await signedWechatHeaders(platformPrivateKey, body),
		});
	});
}

async function signedWechatHeaders(platformPrivateKey: string, body: string) {
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const nonce = "response-nonce";
	const signature = await rsaSha256Sign(
		platformPrivateKey,
		`${timestamp}\n${nonce}\n${body}\n`,
	);
	return {
		"wechatpay-timestamp": timestamp,
		"wechatpay-nonce": nonce,
		"wechatpay-signature": signature,
		"wechatpay-serial": "D4E5F6",
	};
}

async function encryptWechatResource(value: unknown, apiV3Key: string) {
	const nonce = "0123456789ab";
	const associatedData = "transaction";
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(apiV3Key),
		"AES-GCM",
		false,
		["encrypt"],
	);
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv: new TextEncoder().encode(nonce),
			additionalData: new TextEncoder().encode(associatedData),
			tagLength: 128,
		},
		key,
		new TextEncoder().encode(JSON.stringify(value)),
	);
	return {
		algorithm: "AEAD_AES_256_GCM",
		ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
		associated_data: associatedData,
		nonce,
	};
}

function paymentInput(
	overrides: Partial<
		Parameters<ReturnType<typeof createWechatPayProvider>["createPayment"]>[0]
	> = {},
) {
	return {
		attemptId: "11111111-1111-4111-8111-111111111111",
		orderId: "22222222-2222-4222-8222-222222222222",
		orderNumber: "GM100001",
		amountMinor: "12345",
		currency: "CNY",
		currencyDecimals: 2,
		customerEmail: "customer@example.com",
		description: "Order GM100001",
		successUrl: "https://shop.example/orders/GM100001",
		cancelUrl: "https://shop.example/pay/GM100001",
		webhookUrl: "https://shop.example/api/shop/payments/channel/webhook",
		defaultToken: "",
		defaultNetwork: "",
		...overrides,
		payerIp: overrides.payerIp ?? null,
	};
}
