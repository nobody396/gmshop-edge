import { z } from "zod";
import type { PaymentProviderAdapter } from "#/features/shop-payments/provider";
import { epayCredentialSchema } from "#/features/shop-payments/provider";
import { sha256Hex } from "#/features/shop-payments/signature";
import { DomainError } from "#/lib/domain-error";
import { minorToDecimal } from "#/lib/units";
import {
	epusdtMerchantOrderId,
	epusdtUrl,
	manualRefundMethods,
	signEpusdt,
	verifyEpusdtSignature,
} from "./epusdt";
import { readPaymentWebhookText } from "./webhook-body";

const successCodeSchema = z.union([z.literal(1), z.literal("1")]);
const createResponseSchema = z.object({
	code: successCodeSchema,
	msg: z.string().default(""),
	O_id: z.union([z.string(), z.number()]).optional(),
	trade_no: z.union([z.string(), z.number()]).optional(),
	payurl: z.string().default(""),
	payurl2: z.string().default(""),
	qrcode: z.string().default(""),
});
const queryResponseSchema = z.object({
	code: successCodeSchema,
	status: z.union([z.string(), z.number()]),
});
const healthResponseSchema = z.object({ code: successCodeSchema });
const callbackSchema = z.object({
	pid: z.string().min(1),
	trade_no: z.string().min(1),
	out_trade_no: z.string().min(1),
	money: z.string().regex(/^\d+(?:\.\d+)?$/),
	trade_status: z.literal("TRADE_SUCCESS"),
	sign: z.string().min(1),
	sign_type: z.string().toUpperCase().pipe(z.literal("MD5")),
});

const paymentSubject = "老实人AI 额度";

export const epayPaymentProvider: PaymentProviderAdapter = {
	checkoutPresentation: "redirect",
	refundMode: "manual",
	async createPayment(input, rawCredential, fetcher = fetch) {
		const credential = epayCredentialSchema.parse(rawCredential);
		if (!input.payerIp)
			throw new DomainError(
				"payment_payer_ip_required",
				400,
				"Payment provider requires the customer IP address",
			);
		const merchantOrderId = epusdtMerchantOrderId(input.attemptId);
		const params: Record<string, string> = {
			pid: credential.pid,
			type: credential.paymentMethod,
			out_trade_no: merchantOrderId,
			notify_url: input.webhookUrl,
			return_url: input.successUrl,
			name: paymentSubject,
			money: minorToDecimal(input.amountMinor, input.currencyDecimals),
			clientip: input.payerIp,
		};
		params.sign = signEpusdt(
			params,
			credential.secretKey,
			new Set(["sign", "sign_type"]),
		);
		params.sign_type = "MD5";
		const form = new FormData();
		for (const [key, value] of Object.entries(params)) form.set(key, value);
		const response = await fetcher(epusdtUrl(credential.baseUrl, "/mapi.php"), {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok)
			throw new DomainError(
				"payment_provider_unavailable",
				502,
				"Payment provider unavailable",
			);
		let raw: unknown;
		try {
			raw = await response.json();
		} catch {
			throw new DomainError(
				"payment_provider_invalid_response",
				502,
				"Payment provider returned an invalid response",
			);
		}
		const result = createResponseSchema.safeParse(raw);
		if (!result.success)
			throw new DomainError(
				"payment_provider_unavailable",
				502,
				"Payment provider rejected the order",
			);
		const tradeNo = String(result.data.trade_no ?? result.data.O_id ?? "");
		const paymentUrl =
			result.data.payurl || result.data.payurl2 || result.data.qrcode;
		if (!tradeNo || !paymentUrl)
			throw new DomainError(
				"payment_provider_invalid_response",
				502,
				"Payment provider returned an invalid response",
			);
		return {
			providerPaymentId: `${tradeNo}:${merchantOrderId}`,
			checkoutUrl: z
				.url()
				.parse(new URL(paymentUrl, credential.baseUrl).toString()),
			expiresAt: null,
		};
	},
	async queryPayment(providerPaymentId, rawCredential, fetcher = fetch) {
		const credential = epayCredentialSchema.parse(rawCredential);
		const merchantOrderId = providerPaymentId.split(":").at(-1);
		if (!merchantOrderId)
			throw new DomainError(
				"payment_provider_invalid_response",
				502,
				"Payment provider identifier is invalid",
			);
		const url = new URL(epusdtUrl(credential.baseUrl, "/api.php"));
		url.search = new URLSearchParams({
			act: "order",
			pid: credential.pid,
			key: credential.secretKey,
			out_trade_no: merchantOrderId,
		}).toString();
		const response = await fetcher(url, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			throw new DomainError(
				"payment_provider_unavailable",
				502,
				"Payment provider unavailable",
			);
		const result = queryResponseSchema.parse(await response.json());
		return {
			status: Number(result.status) === 1 ? "succeeded" : "pending",
			amountMinor: null,
			currency: null,
		};
	},
	async parseWebhook(request, rawCredential) {
		const credential = epayCredentialSchema.parse(rawCredential);
		if (request.method !== "GET" && request.method !== "POST")
			throw new DomainError(
				"invalid_payment_callback",
				405,
				"Invalid payment callback method",
			);
		const params =
			request.method === "GET"
				? Object.fromEntries(new URL(request.url).searchParams)
				: Object.fromEntries(
						new URLSearchParams(await readPaymentWebhookText(request)),
					);
		verifyEpusdtSignature(params, credential.secretKey, "sign");
		const event = callbackSchema.parse(params);
		if (event.pid !== credential.pid)
			throw new DomainError(
				"invalid_payment_signature",
				401,
				"Invalid payment credential",
			);
		return {
			providerEventId: `epay:${event.trade_no}:${event.trade_status}`,
			providerPaymentId: `${event.trade_no}:${event.out_trade_no}`,
			type: "payment_succeeded",
			amountMinor: null,
			amountDecimal: event.money,
			currency: null,
			merchantOrderId: event.out_trade_no,
			payloadDigest: await sha256Hex(new URLSearchParams(params).toString()),
		};
	},
	...manualRefundMethods,
	async checkHealth(rawCredential, fetcher = fetch) {
		const credential = epayCredentialSchema.parse(rawCredential);
		const url = new URL(epusdtUrl(credential.baseUrl, "/api.php"));
		url.search = new URLSearchParams({
			act: "query",
			pid: credential.pid,
			key: credential.secretKey,
		}).toString();
		const response = await fetcher(url, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			throw new DomainError(
				"payment_provider_unavailable",
				502,
				"Payment provider unavailable",
			);
		healthResponseSchema.parse(await response.json());
	},
};
