import { describe, expect, it, vi } from "vitest";
import { supplierFetchJson } from "#/features/suppliers/providers/http";

describe("supplier HTTP response limits", () => {
	it("parses a bounded JSON response", async () => {
		await expect(
			supplierFetchJson(
				async () => Response.json({ ok: true }),
				"https://supplier.example/api",
				{},
				{ validateDestination: false },
			),
		).resolves.toEqual({ status: 200, body: { ok: true } });
	});

	it("cancels a chunked response once it exceeds the byte limit", async () => {
		const cancel = vi.fn();
		const fetcher: typeof fetch = async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(700_000));
						controller.enqueue(new Uint8Array(700_000));
					},
					cancel,
				}),
			);
		await expect(
			supplierFetchJson(
				fetcher,
				"https://supplier.example/api",
				{},
				{ validateDestination: false },
			),
		).rejects.toMatchObject({ code: "invalid_supplier_response", status: 502 });
		expect(cancel).toHaveBeenCalledWith("body_too_large");
	});
	it("records non-JSON errors with HTTP metadata before throwing", async () => {
		const finish = vi.fn();
		const audit = vi.fn(async () => finish);
		await expect(
			supplierFetchJson(
				async () =>
					new Response("error code: 1010", {
						status: 403,
						headers: { "content-type": "text/plain", "cf-ray": "test-ray" },
					}),
				"https://supplier.example/trade",
				{ method: "POST" },
				{ validateDestination: false, audit },
			),
		).rejects.toMatchObject({ code: "invalid_supplier_response" });
		expect(finish).toHaveBeenCalledWith(
			expect.objectContaining({
				status: 403,
				errorCode: "invalid_json",
				bodyBytes: 16,
				truncated: false,
			}),
		);
		expect(new TextDecoder().decode(finish.mock.calls[0]?.[0].body)).toBe(
			"error code: 1010",
		);
	});

	it("records a bounded prefix and explicit truncation on oversized responses", async () => {
		const finish = vi.fn();
		await expect(
			supplierFetchJson(
				async () => new Response("X".repeat(1_100_000)),
				"https://supplier.example/trade",
				{},
				{ validateDestination: false, audit: async () => finish },
			),
		).rejects.toMatchObject({ code: "invalid_supplier_response" });
		const event = finish.mock.calls[0]?.[0];
		expect(event.truncated).toBe(true);
		expect(event.errorCode).toBe("response_size_limit");
		expect(event.body.byteLength).toBe(1024 * 1024);
	});

	it("records a network failure without inventing a response", async () => {
		const finish = vi.fn();
		await expect(
			supplierFetchJson(
				async () => {
					throw new Error("network");
				},
				"https://supplier.example/trade",
				{},
				{ validateDestination: false, audit: async () => finish },
			),
		).rejects.toMatchObject({ code: "supplier_request_uncertain" });
		expect(finish).toHaveBeenCalledWith(
			expect.objectContaining({
				status: null,
				bodyBytes: 0,
				errorCode: "network_error_or_timeout",
			}),
		);
	});
});
