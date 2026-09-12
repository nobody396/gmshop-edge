type CloudflareRequest = Request & {
	cf?: { country?: string };
};

const mainlandPaymentProviders = new Set(["epay", "alipay_page", "alipay_wap"]);

export function requestIsFromMainlandChina(request: Request) {
	return (request as CloudflareRequest).cf?.country === "CN";
}

export function paymentChannelIsVisible(
	request: Request,
	channel: { provider: string },
) {
	return (
		!requestIsFromMainlandChina(request) ||
		mainlandPaymentProviders.has(channel.provider)
	);
}
