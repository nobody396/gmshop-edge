import { DomainError } from "#/lib/domain-error";

// Server-side diagnostics only. Never expose upstream text to the storefront.
export class PaymentCreationError extends DomainError {
	constructor(
		code: string,
		readonly diagnostics: {
			httpStatus?: number;
			providerCode?: string;
			providerMessage?: string;
		},
	) {
		super(code, 502, "Payment provider could not create a payment");
	}
}

export function redactPaymentProviderText(value: unknown, sensitive: string[]) {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	let text = String(value);
	// Remove exact request/credential values before truncation (including encoded echoes).
	for (const secret of sensitive
		.filter(Boolean)
		.sort((a, b) => b.length - a.length)) {
		for (const representation of [secret, encodeURIComponent(secret)]) {
			text = text.split(representation).join("[REDACTED]");
		}
	}
	return text
		.replace(/https?:\/\/[^\s<>"']+/gi, "[URL]")
		.replace(/[\w.+-]+@[\w.-]+/g, "[EMAIL]")
		.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[\da-f]*:[\da-f:]+\b/gi, "[IP]")
		.replace(
			/\b(?:key|token|secret|password|sign|authorization|cookie|session)\s*[:=]\s*[^\s,;]+/gi,
			"[REDACTED]",
		)
		.replace(/[A-Za-z0-9_+/=-]{24,}/g, "[REDACTED]")
		.replace(/\p{Cc}/gu, " ")
		.slice(0, 240);
}
