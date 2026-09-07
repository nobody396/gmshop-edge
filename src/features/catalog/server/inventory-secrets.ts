export function normalizeInventorySecrets(content: string) {
	return [
		...new Set(
			content
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
}

export function formatInventoryDelivery(
	secret: string,
	usageUrl?: string | null,
	requireUsageUrl = false,
) {
	if (requireUsageUrl && !usageUrl)
		throw new DomainError(
			"inventory_usage_url_required",
			400,
			"A recharge URL is required for supplier-backed CDK inventory",
		);
	return usageUrl ? `CDK：${secret}\n充值地址：${usageUrl}` : secret;
}

export function fingerprintInventorySecret(
	value: string,
	fingerprintPepper: string,
) {
	return hmacSha256Hex(`gmshop-card-fingerprint:${fingerprintPepper}`, value);
}

export function maskInventorySecret(value: string) {
	const tail = value.slice(-4);
	return `${"•".repeat(Math.min(8, Math.max(4, value.length - tail.length)))}${tail}`;
}

import { hmacSha256Hex } from "#/lib/crypto";
import { DomainError } from "#/lib/domain-error";
