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
) {
	return usageUrl ? `CDK：${secret}\n兑换地址：${usageUrl}` : secret;
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
