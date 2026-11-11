import type {
	PaymentProvider,
	PaymentProviderAdapter,
} from "#/features/shop-payments/provider";
import { DomainError } from "#/lib/domain-error";
import {
	createAlipayQrProvider,
	createAutomaticAlipayProvider,
} from "./alipay";
import { cryptomusPaymentProvider } from "./cryptomus";
import { epayPaymentProvider } from "./epay";
import { gmpayPaymentProvider } from "./gmpay";
import { stripePaymentProvider } from "./stripe";
import { createAutomaticWechatPayProvider } from "./wechatpay";

const automaticAlipayProvider = createAutomaticAlipayProvider();
const automaticWechatPayProvider = createAutomaticWechatPayProvider();

const providers: Record<PaymentProvider, PaymentProviderAdapter> = {
	stripe: stripePaymentProvider,
	cryptomus: cryptomusPaymentProvider,
	gmpay: gmpayPaymentProvider,
	epay: epayPaymentProvider,
	alipay_page: automaticAlipayProvider,
	alipay_wap: automaticAlipayProvider,
	alipay_qr: createAlipayQrProvider(),
	wechat_native: automaticWechatPayProvider,
	wechat_h5: automaticWechatPayProvider,
};

export function getPaymentProvider(provider: string) {
	const adapter = providers[provider as PaymentProvider];
	if (!adapter)
		throw new DomainError(
			"payment_provider_unsupported",
			400,
			"Unsupported payment provider",
		);
	return adapter;
}

export function paymentCheckoutPresentation(
	provider: string,
	checkoutUrl?: string | null,
) {
	if ((provider === "wechat_native" || provider === "wechat_h5") && checkoutUrl)
		return checkoutUrl.startsWith("weixin://") ? "qr" : "redirect";
	return getPaymentProvider(provider).checkoutPresentation;
}
