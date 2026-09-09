import { createFileRoute } from "@tanstack/react-router";
import { storeOrderLookupSchema } from "#/features/storefront/schema";
import { getEnv } from "#/server/db.server";

async function digest(value: string) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function authorized(request: Request, expected: string) {
	const header = request.headers.get("authorization") ?? "";
	const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	if (!expected || !provided) return false;
	const [left, right] = await Promise.all([digest(provided), digest(expected)]);
	return left === right;
}

export const Route = createFileRoute("/api/shop/invoice-order")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const env = getEnv() as Env & { INVOICE_LOOKUP_TOKEN?: string };
				if (
					!(await authorized(request, env.INVOICE_LOOKUP_TOKEN?.trim() ?? ""))
				)
					return Response.json(
						{ code: "not_found" },
						{ status: 404, headers: { "Cache-Control": "private, no-store" } },
					);
				if (Number(request.headers.get("content-length") ?? 0) > 4096)
					return Response.json({ code: "request_too_large" }, { status: 413 });
				try {
					const input = storeOrderLookupSchema.parse(await request.json());
					const order = await env.DB.prepare(
						`SELECT id, order_number, status, currency, currency_decimals,
						 total_minor, paid_minor, refunded_at
						 FROM shop_orders
						 WHERE order_number = ? AND normalized_contact_email = ? LIMIT 1`,
					)
						.bind(input.orderNumber, input.email)
						.first<Record<string, unknown>>();
					if (
						!order ||
						!["paid", "fulfilling", "completed"].includes(
							String(order.status),
						) ||
						order.refunded_at != null ||
						String(order.currency) !== "CNY" ||
						Number(order.currency_decimals) !== 2 ||
						BigInt(String(order.paid_minor)) !==
							BigInt(String(order.total_minor)) ||
						BigInt(String(order.total_minor)) <= 0n
					)
						return Response.json(
							{ code: "not_found" },
							{
								status: 404,
								headers: { "Cache-Control": "private, no-store" },
							},
						);
					return Response.json(
						{
							orderNumber: String(order.order_number),
							amountMinor: String(order.total_minor),
							currency: "CNY",
							currencyDecimals: 2,
						},
						{ headers: { "Cache-Control": "private, no-store" } },
					);
				} catch {
					return Response.json(
						{ code: "not_found" },
						{ status: 404, headers: { "Cache-Control": "private, no-store" } },
					);
				}
			},
		},
	},
});
