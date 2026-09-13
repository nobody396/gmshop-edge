import { DomainError } from "#/lib/domain-error";
import { decryptSecret } from "#/lib/secrets";

const warehouseBaseUrl = "https://redeem.laoshirenvip.com";
export async function requestWarehouse(
	token: string,
	path: string,
	init: RequestInit = {},
	fetcher: typeof fetch = fetch,
) {
	let response: Response;
	try {
		response = await fetcher(`${warehouseBaseUrl}${path}`, {
			...init,
			redirect: "manual",
			headers: {
				Authorization: `Bearer ${token}`,
				...(init.body ? { "Content-Type": "application/json" } : {}),
			},
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		throw new DomainError(
			"redeem_warehouse_unreachable",
			502,
			"Warehouse unavailable",
		);
	}
	const text = await response.text();
	if (text.length > 1_000_000)
		throw new DomainError(
			"redeem_warehouse_response_too_large",
			502,
			"Warehouse response too large",
		);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new DomainError(
			"redeem_warehouse_invalid_response",
			502,
			"Warehouse returned invalid data",
		);
	}
	if (
		!response.ok &&
		body &&
		typeof body === "object" &&
		"code" in body &&
		typeof body.code === "string" &&
		[
			"activation.cooldown",
			"provider.temporary_error",
			"provider.needs_review",
			"conversion.conflict",
			"conversion.unsupported_key",
			"conversion.key_already_owned",
			"service.not_enabled",
			"input.invalid",
		].includes(body.code)
	) {
		throw new DomainError(
			`redeem_warehouse_http_${response.status}_${body.code}`,
			502,
			"Warehouse operation failed",
		);
	}
	if (!response.ok)
		throw new DomainError(
			"redeem_warehouse_request_failed",
			502,
			"Warehouse request failed",
		);
	return body;
}

export async function loadDeliveryWarehouseToken(
	db: D1Database,
	commerceSecret: string,
) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key='integration.redeem_warehouse_token'",
		)
		.first<{ value: string }>();
	const envelope: unknown = row ? JSON.parse(row.value) : null;
	if (typeof envelope !== "string")
		throw new DomainError(
			"redeem_warehouse_unavailable",
			503,
			"Warehouse configuration unavailable",
		);
	return decryptSecret(envelope, commerceSecret, "redeem-warehouse-token");
}
