import { z } from "zod";
import { m } from "#/paraglide/messages";

const invoiceSchema = z.object({
	fees_included: z.boolean().optional(),
	request_no: z.string().optional(),
	consumption_screenshot: z.boolean().optional(),
	screenshot_fee_amount: z.string().optional(),
	status: z.string().optional(),
	invoice_base_amount: z.string().optional(),
	invoice_total_amount: z.string(),
	invoice_fee_amount: z.string(),
	payment_fee_amount: z.string(),
	payment_amount: z.string(),
	pay_url: z.string().optional(),
	qr_code: z.string().optional(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

// An order preview can run before the amount is known: the service prefills
// the base amount from the paid amount. Offline applications need the amount.
export function canPreview(form: Record<string, string>): boolean {
	return form.order_no?.trim()
		? Boolean(form.order_email?.trim())
		: Boolean(form.invoice_amount?.trim());
}

export async function send(input: {
	action: string;
	request_no?: string;
	order_no?: string;
	order_email?: string;
	invoice_amount?: string;
	buyer_title?: string;
	tax_number?: string;
	recipient_email?: string;
	consumption_screenshot?: boolean;
}): Promise<Invoice> {
	const { action, request_no, ...form } = input;
	if (!["preview", "create", "status"].includes(action ?? ""))
		throw new Error(m.invoice_error());
	if (action === "status" && !/^[A-Za-z0-9_-]{1,100}$/.test(request_no ?? ""))
		throw new Error(m.invoice_error());
	const path =
		action === "status"
			? `public/invoices/${request_no}`
			: `guest/invoices/gmshop${form.order_no?.trim() ? "" : "/manual"}${action === "preview" ? "/preview" : ""}`;
	const payload =
		action === "preview"
			? {
					order_no: form.order_no,
					order_email: form.order_email,
					invoice_amount: form.invoice_amount,
					consumption_screenshot: form.consumption_screenshot,
				}
			: form;
	const response = await fetch(`https://lsrai.shop/api/v1/${path}`, {
		method: action === "status" ? "GET" : "POST",
		credentials: "omit",
		headers: { "content-type": "application/json" },
		...(action === "status"
			? {}
			: { body: JSON.stringify({ ...payload, payment_method: "alipay" }) }),
		signal: AbortSignal.timeout(20000),
	});
	const envelope = z
		.object({
			status_code: z.number().optional(),
			msg: z.string().optional(),
			data: z.unknown().optional(),
		})
		.safeParse(await response.json().catch(() => null));
	if (!envelope.success) throw new Error(m.invoice_error());
	const body = envelope.data;
	if (
		!response.ok ||
		(body.status_code !== undefined && body.status_code !== 0)
	)
		throw new Error(body.msg || m.invoice_error());
	const invoice = invoiceSchema.safeParse(body.data);
	if (!invoice.success) throw new Error(m.invoice_error());
	// Preview must use the new pricing contract; historical status stays readable.
	if (action === "preview" && invoice.data.fees_included !== true)
		throw new Error(m.invoice_pricing_unavailable());
	// Do not accept a stale backend silently ignoring a selected paid option.
	if (
		input.consumption_screenshot &&
		(invoice.data.consumption_screenshot !== true ||
			invoice.data.screenshot_fee_amount !== "5.00" ||
			!invoice.data.invoice_base_amount)
	)
		throw new Error(m.invoice_screenshot_unavailable());
	return invoice.data;
}
