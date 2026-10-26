import {
	iproyalIspProductId,
	parseIproyalDate,
} from "../domain";

/**
 * Minimal IPRoyal reseller REST client (https://apid.iproyal.com/v1/reseller,
 * header X-Access-Token). Shapes follow docs.iproyal.com/proxies/isp/api
 * (orders.md, user.md) as read on 2026-10-24.
 */
export const iproyalApiBase = "https://apid.iproyal.com/v1/reseller";
const timeoutMs = 20_000;

/** `definite` = IPRoyal answered with a 4xx, so nothing was charged/changed. */
export class IproyalError extends Error {
	constructor(
		readonly code: string,
		readonly status: number | null,
		readonly definite: boolean,
		detail = "",
	) {
		super(detail ? `${code}: ${detail}` : code);
	}
}

export type IproyalClient = ReturnType<typeof createIproyalClient>;

export function createIproyalClient(token: string, fetcher: typeof fetch) {
	async function call(method: string, path: string, body?: unknown) {
		let response: Response;
		try {
			response = await fetcher(`${iproyalApiBase}${path}`, {
				method,
				headers: {
					"X-Access-Token": token,
					Accept: "application/json",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw new IproyalError(
				"iproyal_unreachable",
				null,
				false,
				error instanceof Error ? error.name : "",
			);
		}
		const text = await response.text();
		if (!response.ok)
			throw new IproyalError(
				"iproyal_http_error",
				response.status,
				response.status >= 400 && response.status < 500,
				text.slice(0, 200),
			);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new IproyalError(
				"iproyal_bad_json",
				response.status,
				false,
				text.slice(0, 100),
			);
		}
	}

	return {
		/** GET /balance → a bare number such as 884.05 (USD). */
		async balance() {
			const value = await call("GET", "/balance");
			const number =
				typeof value === "number"
					? value
					: typeof value === "string"
						? Number(value)
						: value && typeof value === "object" && "balance" in value
							? Number((value as { balance: unknown }).balance)
							: Number.NaN;
			if (!Number.isFinite(number))
				throw new IproyalError("iproyal_bad_balance", 200, false);
			return number;
		},
		products() {
			return call("GET", "/products");
		},
		async price(planId: number, locationId: number) {
			const query = new URLSearchParams({
				product_id: String(iproyalIspProductId),
				product_plan_id: String(planId),
				product_location_id: String(locationId),
				quantity: "1",
			});
			const value = (await call(
				"GET",
				`/orders/calculate-pricing?${query}`,
			)) as { price_with_vat?: unknown; total?: unknown } | null;
			const price = Number(value?.price_with_vat ?? value?.total);
			return Number.isFinite(price) ? price : null;
		},
		/** POST /orders — call at most once per subscription (see cron idempotency). */
		async createOrder(planId: number, locationId: number) {
			const value = (await call("POST", "/orders", {
				product_id: iproyalIspProductId,
				product_plan_id: planId,
				product_location_id: locationId,
				quantity: 1,
				auto_extend: false,
				// Question 17 ("new IP on every renewal") only accepts a string and a
				// boolean is rejected with 422. Omitting it leaves it unchecked, so
				// renewals keep the same IP (verified on order 86547609, 2026-10-26).
			})) as { id?: unknown } | null;
			const id = value?.id;
			if (typeof id !== "number" && typeof id !== "string")
				throw new IproyalError("iproyal_order_id_missing", 200, false);
			return String(id);
		},
		/** proxy = null until the IP is assigned; expiresAt = parsed `expire_date`. */
		async getOrder(orderId: string): Promise<IproyalOrder> {
			const order = await call("GET", `/orders/${encodeURIComponent(orderId)}`);
			return {
				proxy: parseOrderProxy(order),
				expiresAt: parseIproyalDate(
					(order as { expire_date?: unknown } | null)?.expire_date,
				),
			};
		},
		/**
		 * POST /orders/{id}/extend {product_plan_id, proxies: []} — documented
		 * "Extend Order"; an empty `proxies` list extends every proxy in the order.
		 */
		async extendOrder(orderId: string, planId: number) {
			await call("POST", `/orders/${encodeURIComponent(orderId)}/extend`, {
				product_plan_id: planId,
				proxies: [],
			});
		},
	};
}

export type IproyalOrder = {
	proxy: IproyalProxy | null;
	expiresAt: number | null;
};

export type IproyalProxy = {
	ip: string;
	port: number;
	username: string;
	password: string;
	location: string | null;
};

/** proxy_data.proxies[0] + ports["http|https"]; null until the IP is assigned. */
export function parseOrderProxy(order: unknown): IproyalProxy | null {
	if (!order || typeof order !== "object") return null;
	const value = order as {
		location?: unknown;
		proxy_data?: {
			ports?: Record<string, unknown>;
			proxies?: Array<Record<string, unknown>>;
		};
	};
	const proxy = value.proxy_data?.proxies?.[0];
	const port = Number(value.proxy_data?.ports?.["http|https"]);
	if (
		!proxy ||
		typeof proxy.ip !== "string" ||
		typeof proxy.username !== "string" ||
		typeof proxy.password !== "string" ||
		!proxy.ip ||
		!proxy.username ||
		!proxy.password ||
		!Number.isInteger(port) ||
		port <= 0
	)
		return null;
	return {
		ip: proxy.ip,
		port,
		username: proxy.username,
		password: proxy.password,
		location: typeof value.location === "string" ? value.location : null,
	};
}
