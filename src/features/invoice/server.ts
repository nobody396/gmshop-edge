import { z } from "zod";
import { getEnv } from "#/server/db.server";
import { json } from "#/server/http";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";

export const invoiceInput = z.object({
	action: z.enum(["preview", "create", "status"]),
	request_no: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,100}$/)
		.optional(),
	order_no: z.string().trim().max(100).default(""),
	order_email: z.string().trim().max(254).default(""),
	invoice_amount: z
		.string()
		.regex(/^\d{1,10}(\.\d{1,2})?$/)
		.optional(),
	buyer_title: z.string().trim().max(200).optional(),
	tax_number: z.string().trim().max(100).optional(),
	recipient_email: z.email().max(254).optional(),
});

export async function invoiceRequest(request: Request) {
	if (request.headers.get("origin") !== new URL(request.url).origin)
		return json({ msg: "Forbidden" }, { status: 403 });
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	const limit = await claimFixedWindowRateLimit(getEnv().DB, {
		bucketKey: `invoice:${ip}`,
		limit: 40,
		windowMs: 60000,
	});
	if (!limit.allowed)
		return json({ msg: "Too many requests" }, { status: 429 });
	try {
		const reader = request.body?.getReader();
		if (!reader) return json({ msg: "Invalid request" }, { status: 400 });
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > 8192) {
				await reader.cancel();
				return json({ msg: "Request too large" }, { status: 413 });
			}
			chunks.push(chunk.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		const parsed = invoiceInput.safeParse(
			JSON.parse(new TextDecoder().decode(bytes)),
		);
		if (!parsed.success)
			return json({ msg: "Invalid request" }, { status: 400 });
		const { action, request_no, ...payload } = parsed.data;
		if (action === "status" && !request_no)
			return json({ msg: "Invalid request" }, { status: 400 });
		const path =
			action === "status"
				? `public/invoices/${request_no}`
				: `guest/invoices/gmshop${payload.order_no ? "" : "/manual"}${action === "preview" ? "/preview" : ""}`;
		const upstream = await fetch(`https://lsrai.shop/api/v1/${path}`, {
			method: action === "status" ? "GET" : "POST",
			headers: {
				"content-type": "application/json",
				"X-Lang": request.headers.get("accept-language")?.startsWith("en")
					? "en-US"
					: "zh-CN",
			},
			...(action === "status"
				? {}
				: { body: JSON.stringify({ ...payload, payment_method: "alipay" }) }),
			redirect: "error",
			signal: AbortSignal.timeout(20000),
		});
		const body = await upstream.json();
		return json(body, { status: upstream.status });
	} catch {
		return json({ msg: "Invoice service unavailable" }, { status: 502 });
	}
}
