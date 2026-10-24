import { describe, expect, it, vi } from "vitest";
import {
	createIproyalClient,
	IproyalError,
	parseOrderProxy,
} from "#/features/claude-env/server/iproyal";

function mockFetch(
	responses: Array<{ status?: number; body: unknown } | Error>,
) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetcher = vi.fn(async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const next = responses.shift();
		if (!next) throw new Error("unexpected call");
		if (next instanceof Error) throw next;
		return new Response(
			typeof next.body === "string" ? next.body : JSON.stringify(next.body),
			{ status: next.status ?? 200 },
		);
	});
	return { fetcher: fetcher as unknown as typeof fetch, calls };
}

describe("IPRoyal reseller client", () => {
	it("reads a bare-number balance with the access token header", async () => {
		const { fetcher, calls } = mockFetch([{ body: "884.05" }]);
		expect(await createIproyalClient("tok", fetcher).balance()).toBe(884.05);
		expect(calls[0]?.url).toBe("https://apid.iproyal.com/v1/reseller/balance");
		expect(
			(calls[0]?.init.headers as Record<string, string>)["X-Access-Token"],
		).toBe("tok");
	});

	it("creates an ISP order: product 9, quantity 1, no auto-extend, never a new IP on renew", async () => {
		const { fetcher, calls } = mockFetch([{ body: { id: 4242 } }]);
		const id = await createIproyalClient("tok", fetcher).createOrder(25, 187);
		expect(id).toBe("4242");
		expect(calls[0]?.url).toBe("https://apid.iproyal.com/v1/reseller/orders");
		expect(calls[0]?.init.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			product_id: 9,
			product_plan_id: 25,
			product_location_id: 187,
			quantity: 1,
			auto_extend: false,
			product_question_answers: { "17": false },
		});
	});

	it("extends with POST /orders/{id}/extend and an empty proxies list", async () => {
		const { fetcher, calls } = mockFetch([{ body: { id: 4242 } }]);
		await createIproyalClient("tok", fetcher).extendOrder("4242", 22);
		expect(calls[0]?.url).toBe(
			"https://apid.iproyal.com/v1/reseller/orders/4242/extend",
		);
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			product_plan_id: 22,
			proxies: [],
		});
	});

	it("classifies 4xx as definite and network/5xx as unknown", async () => {
		const { fetcher } = mockFetch([
			{ status: 422, body: { message: "insufficient balance" } },
			{ status: 502, body: "bad gateway" },
			new TypeError("network"),
		]);
		const client = createIproyalClient("tok", fetcher);
		await expect(client.createOrder(22, 1)).rejects.toMatchObject({
			definite: true,
			status: 422,
		});
		await expect(client.createOrder(22, 1)).rejects.toMatchObject({
			definite: false,
			status: 502,
		});
		const error = await client.createOrder(22, 1).catch((e) => e);
		expect(error).toBeInstanceOf(IproyalError);
		expect(error.definite).toBe(false);
	});

	it("reads pricing and order proxies", async () => {
		const { fetcher } = mockFetch([
			{ body: { price_with_vat: 5.2 } },
			{
				body: {
					id: 1,
					proxy_data: { ports: { "http|https": 12323 }, proxies: [] },
				},
			},
			{
				body: {
					id: 1,
					location: "United States",
					proxy_data: {
						ports: { socks5: 12324, "http|https": 12323 },
						proxies: [{ ip: "161.77.8.204", username: "u1", password: "p1" }],
					},
				},
			},
		]);
		const client = createIproyalClient("tok", fetcher);
		expect(await client.price(22, 187)).toBe(5.2);
		expect(await client.getOrder("1")).toBeNull();
		expect(await client.getOrder("1")).toEqual({
			ip: "161.77.8.204",
			port: 12323,
			username: "u1",
			password: "p1",
			location: "United States",
		});
		expect(parseOrderProxy(null)).toBeNull();
	});
});
