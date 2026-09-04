import { DomainError } from "#/lib/domain-error";
import { encryptSecret } from "#/lib/secrets";
import type { SupplierHttpAudit } from "../providers/http";

export type SupplierDiagnosticStorage = {
	put(
		key: string,
		value: string,
		options?: { httpMetadata: { contentType: string } },
	): Promise<unknown>;
};

export type SupplierDiagnosticsContext = {
	db: D1Database;
	files: SupplierDiagnosticStorage;
	supplierOrderId: string;
};

const sensitiveKey =
	/^(?:authorization|cookie|set-cookie|password|sign|signature|token|access_token|refresh_token|app_id|api_id|app_key|api_key|api_secret|apiKey|apiSecret|appKey|appId)$/i;
const retainedHeaders = new Set([
	"content-type",
	"content-length",
	"content-encoding",
	"server",
	"cf-ray",
	"retry-after",
	"date",
	"x-request-id",
	"user-agent",
	"accept",
]);

export function createSupplierHttpAudit(
	input: SupplierDiagnosticsContext & {
		accountId: string;
		commerceSecret: string;
		credentialValues: string[];
		direction?: "outbound" | "callback";
	},
): SupplierHttpAudit {
	const scrub = (value: string) => {
		let result = value;
		for (const secret of input.credentialValues.filter(Boolean)) {
			for (const encoded of new Set([
				secret,
				encodeURIComponent(secret),
				JSON.stringify(secret).slice(1, -1),
			]))
				result = result.replaceAll(encoded, "[REDACTED]");
		}
		return result;
	};
	const cleanObject = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(cleanObject);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					key,
					sensitiveKey.test(key) ? "[REDACTED]" : cleanObject(item),
				]),
			);
		return typeof value === "string" ? scrub(value) : value;
	};
	const cleanText = (value: string) => {
		try {
			return JSON.stringify(cleanObject(JSON.parse(scrub(value))));
		} catch {
			return scrub(value);
		}
	};
	const headers = (value: Headers) =>
		Object.fromEntries(
			[...value.entries()]
				.filter(([key]) => retainedHeaders.has(key))
				.map(([key, value]) => [key, scrub(value)]),
		);
	return async ({ url, init }) => {
		const id = crypto.randomUUID();
		const startedAt = Date.now();
		const destination = new URL(url);
		for (const [key, value] of destination.searchParams)
			destination.searchParams.set(
				key,
				sensitiveKey.test(key) ? "[REDACTED]" : scrub(value),
			);
		const requestHeaders = new Headers(init.headers);
		const rawBody =
			typeof init.body === "string"
				? init.body
				: init.body instanceof URLSearchParams
					? init.body.toString()
					: "";
		const requestBody = requestHeaders
			.get("content-type")
			?.includes("application/x-www-form-urlencoded")
			? JSON.stringify(
					[...new URLSearchParams(rawBody)].map(([key, value]) => [
						key,
						sensitiveKey.test(key) || key === "secret"
							? "[REDACTED]"
							: scrub(value),
					]),
				)
			: cleanText(rawBody);
		const request = {
			url: scrub(destination.toString()),
			method: init.method ?? "GET",
			headers: headers(requestHeaders),
			body: requestBody,
		};
		const objectKey = `supplier-diagnostics/v1/${input.supplierOrderId}/${id}.json.enc`;
		const save = async (value: unknown) =>
			input.files.put(
				objectKey,
				await encryptSecret(
					JSON.stringify(value),
					input.commerceSecret,
					"supplier-diagnostic",
				),
				{ httpMetadata: { contentType: "application/octet-stream" } },
			);
		try {
			// Durable request evidence must exist before any network side effect.
			await save({
				version: 1,
				id,
				startedAt,
				request,
				response: null,
			});
			await input.db
				.prepare(`INSERT INTO supplier_exchange_records
			 (id, supplier_order_id, account_id, direction, method, path, status, object_key, started_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?)`)
				.bind(
					id,
					input.supplierOrderId,
					input.accountId,
					input.direction ?? "outbound",
					request.method,
					destination.pathname,
					objectKey,
					startedAt,
				)
				.run();
		} catch {
			throw new DomainError(
				"supplier_diagnostics_unavailable",
				503,
				"Supplier diagnostics could not be recorded before request",
			);
		}
		return async (result) => {
			const completedAt = Date.now();
			const safeHeaders = headers(result.headers);
			const summary = {
				exchangeId: id,
				httpStatus: result.status,
				contentType: safeHeaders["content-type"] ?? null,
				bodyBytes: result.bodyBytes,
				retainedBytes: result.body.byteLength,
				truncated: result.truncated,
				errorCode: result.errorCode,
			};
			try {
				await save({
					version: 1,
					id,
					startedAt,
					completedAt,
					request,
					response: {
						...summary,
						headers: safeHeaders,
						body: cleanText(new TextDecoder().decode(result.body)),
					},
				});
				await input.db
					.prepare(`UPDATE supplier_exchange_records SET status = 'recorded', http_status = ?,
				 content_type = ?, response_bytes = ?, retained_bytes = ?, truncated = ?, error_code = ?, completed_at = ? WHERE id = ?`)
					.bind(
						result.status,
						summary.contentType,
						result.bodyBytes,
						result.body.byteLength,
						result.truncated ? 1 : 0,
						result.errorCode,
						completedAt,
						id,
					)
					.run();
				if (result.errorCode)
					await input.db
						.prepare(
							"UPDATE supplier_orders SET last_error_message_redacted = ? WHERE id = ?",
						)
						.bind(JSON.stringify(summary), input.supplierOrderId)
						.run();
			} catch {
				try {
					await input.db
						.prepare(
							"UPDATE supplier_exchange_records SET status = 'recording_failed', error_code = 'diagnostics_persist_failed', completed_at = ? WHERE id = ?",
						)
						.bind(completedAt, id)
						.run();
				} catch {
					/* Leave the durable started record for recovery. */
				}
				throw new DomainError(
					"supplier_request_uncertain",
					503,
					"Supplier response diagnostics could not be persisted",
				);
			}
		};
	};
}
