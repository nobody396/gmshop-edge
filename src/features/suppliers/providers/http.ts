import { DomainError } from "#/lib/domain-error";
import { assertPublicSupplierHostname } from "../server/destination-security";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type SupplierHttpAudit = (request: {
	url: string;
	init: RequestInit;
}) => Promise<
	(response: {
		status: number | null;
		headers: Headers;
		body: Uint8Array;
		bodyBytes: number;
		truncated: boolean;
		errorCode: string | null;
	}) => Promise<void>
>;

export async function supplierFetchJson(
	fetcher: typeof fetch,
	url: string,
	init: RequestInit,
	options: { validateDestination?: boolean; audit?: SupplierHttpAudit } = {},
): Promise<{ status: number; body: unknown }> {
	const destination = new URL(url);
	if (destination.protocol !== "https:" || destination.port)
		throw new DomainError(
			"supplier_destination_rejected",
			400,
			"Supplier destination is not allowed",
		);
	if (options.validateDestination !== false)
		await assertPublicSupplierHostname(destination.hostname);
	const record = await options.audit?.({ url, init });
	let response: Response;
	try {
		response = await fetcher(url, {
			...init,
			redirect: "manual",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		await record?.({
			status: null,
			headers: new Headers(),
			body: new Uint8Array(),
			bodyBytes: 0,
			truncated: false,
			errorCode: "network_error_or_timeout",
		});
		throw new DomainError(
			"supplier_request_uncertain",
			502,
			"Supplier request outcome is uncertain",
		);
	}
	// Read once and retain the bounded prefix even for invalid JSON or oversized
	// responses. Never tee the stream: cancellation of a clone can deadlock.
	const chunks: Uint8Array[] = [];
	let size = 0;
	let retained = 0;
	let truncated = false;
	let readFailed = false;
	const reader = response.body?.getReader();
	try {
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			const keep = value.slice(0, Math.max(0, MAX_RESPONSE_BYTES - retained));
			chunks.push(keep);
			retained += keep.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				truncated = true;
				await reader.cancel("body_too_large");
				break;
			}
		}
	} catch {
		readFailed = true;
	} finally {
		reader?.releaseLock();
	}
	const bytes = new Uint8Array(retained);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const declared = response.headers.get("content-length");
	const invalidLength =
		declared !== null &&
		(!Number.isSafeInteger(Number(declared)) ||
			Number(declared) < 0 ||
			Number(declared) > MAX_RESPONSE_BYTES);
	let body: unknown;
	let errorCode: string | null = readFailed
		? "response_read_failed"
		: truncated || invalidLength
			? "response_size_limit"
			: null;
	if (!errorCode) {
		try {
			body = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			errorCode = "invalid_json";
		}
	}
	const redirect = response.status >= 300 && response.status < 400;
	if (redirect) errorCode = "redirect_rejected";
	await record?.({
		status: response.status,
		headers: response.headers,
		body: bytes,
		bodyBytes: size,
		truncated: truncated || readFailed,
		errorCode,
	});
	if (redirect)
		throw new DomainError(
			"supplier_redirect_rejected",
			502,
			"Supplier redirects are not allowed",
		);
	if (readFailed)
		throw new DomainError(
			"supplier_request_uncertain",
			502,
			"Supplier response read failed",
		);
	if (errorCode)
		throw new DomainError(
			"invalid_supplier_response",
			502,
			"Supplier returned an invalid response",
		);
	return { status: response.status, body };
}
