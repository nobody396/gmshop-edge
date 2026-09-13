"use client";
import { QRCodeSVG } from "qrcode.react";
import { type SyntheticEvent, useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { m } from "#/paraglide/messages";
import { type Invoice, send } from "./client";

export function InvoicePage() {
	const [form, setForm] = useState({
		order_no: "",
		order_email: "",
		invoice_amount: "",
		buyer_title: "",
		tax_number: "",
		recipient_email: "",
	});
	const [preview, setPreview] = useState<Invoice | null>(null);
	const [result, setResult] = useState<Invoice | null>(null);
	const [requestNo, setRequestNo] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		const query = new URLSearchParams(window.location.search);
		setForm((f) => ({ ...f, order_no: query.get("order_no") || "" }));
		setRequestNo(query.get("request_no") || "");
	}, []);
	useEffect(() => {
		if (!requestNo) return;
		let stopped = false;
		let terminal = false;
		const refresh = async () => {
			if (terminal) return;
			try {
				const data = await send({ action: "status", request_no: requestNo });
				if (!stopped) {
					setResult(data);
					terminal = ["completed", "cancelled", "email_failed"].includes(
						data.status ?? "",
					);
					setError("");
				}
			} catch {
				if (!stopped) setError(m.invoice_error());
			}
		};
		void refresh();
		const timer = window.setInterval(() => void refresh(), 5000);
		return () => {
			stopped = true;
			window.clearInterval(timer);
		};
	}, [requestNo]);
	async function submit(event: SyntheticEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const data = await send({
				...form,
				action: preview ? "create" : "preview",
			});
			if (preview) {
				setResult(data);
				if (data.request_no) {
					setRequestNo(data.request_no);
					window.history.replaceState(
						null,
						"",
						`/invoice?request_no=${encodeURIComponent(data.request_no)}`,
					);
				}
			} else setPreview(data);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : m.invoice_error());
		} finally {
			setBusy(false);
		}
	}
	const statusLabels: Record<string, string> = {
		pending_payment: m.invoice_pending(),
		pending_issue: m.invoice_processing(),
		pending_email: m.invoice_sending(),
		completed: m.invoice_done(),
		email_failed: m.invoice_failed(),
		cancelled: m.invoice_cancelled(),
	};
	const amounts = result || preview;
	const paymentURL =
		result?.pay_url && /^https:\/\//i.test(result.pay_url)
			? result.pay_url
			: undefined;
	const qr = result?.qr_code || paymentURL;
	const labels = {
		order_no: m.invoice_order(),
		order_email: m.invoice_order_email(),
		invoice_amount: m.invoice_amount(),
		buyer_title: m.invoice_buyer(),
		tax_number: m.invoice_tax(),
		recipient_email: m.invoice_email(),
	};
	return (
		<main className="container mx-auto max-w-2xl px-4 py-10 sm:py-16">
			<h1 className="font-bold text-3xl">{m.invoice_title()}</h1>
			<p className="mt-3 text-muted-foreground">{m.invoice_intro()}</p>
			<p className="mt-2 text-muted-foreground text-sm">{m.invoice_item()}</p>
			<div className="mt-8 rounded-xl border bg-card p-5 sm:p-8">
				{requestNo ? (
					<section className="space-y-4" aria-live="polite">
						<h2 className="font-semibold text-xl">
							{result?.status === "pending_payment"
								? m.invoice_pending()
								: result?.status === "completed"
									? m.invoice_done()
									: m.invoice_processing()}
						</h2>
						<p className="break-all text-sm">
							{m.invoice_number()}: {requestNo}
						</p>
						{result?.status && (
							<p>
								{m.invoice_status()}:{" "}
								{statusLabels[result.status] ?? m.invoice_processing()}
							</p>
						)}
						{result?.status === "pending_payment" && qr && (
							<QRCodeSVG
								value={qr}
								size={224}
								className="mx-auto rounded-lg bg-white p-3"
								title={m.invoice_pay()}
							/>
						)}
						{result?.status === "pending_payment" && paymentURL && (
							<Button asChild>
								<a href={paymentURL} target="_blank" rel="noopener noreferrer">
									{m.invoice_pay()}
								</a>
							</Button>
						)}
					</section>
				) : (
					<form onSubmit={submit} className="space-y-5">
						{(Object.keys(form) as Array<keyof typeof form>)
							.filter((key) => key !== "order_email" || form.order_no)
							.map((key) => (
								<label
									key={key}
									htmlFor={`invoice-${key}`}
									className="grid gap-2 text-sm"
								>
									<span>{labels[key]}</span>
									<Input
										id={`invoice-${key}`}
										value={form[key]}
										type={
											key.includes("email")
												? "email"
												: key === "invoice_amount"
													? "number"
													: "text"
										}
										min={key === "invoice_amount" ? "0.01" : undefined}
										step={key === "invoice_amount" ? "0.01" : undefined}
										maxLength={key.includes("email") ? 254 : 200}
										required={key !== "order_no"}
										disabled={busy}
										onChange={(event) => {
											setForm({ ...form, [key]: event.target.value });
											setPreview(null);
										}}
									/>
								</label>
							))}
						<p className="text-muted-foreground text-sm">{m.invoice_hint()}</p>
						<Button className="w-full" disabled={busy} type="submit">
							{busy
								? m.invoice_loading()
								: preview
									? m.invoice_confirm()
									: m.invoice_preview()}
						</Button>
					</form>
				)}
				{amounts && (
					<dl
						className="mt-6 grid grid-cols-2 gap-3 rounded-lg bg-muted/40 p-4 text-sm"
						aria-live="polite"
					>
						<dt>{m.invoice_amount()}</dt>
						<dd>¥{amounts.invoice_total_amount}</dd>
						<dt>{m.invoice_fee()}</dt>
						<dd>¥{amounts.invoice_fee_amount}</dd>
						<dt>{m.invoice_payment_fee()}</dt>
						<dd>¥{amounts.payment_fee_amount}</dd>
						<dt className="font-semibold">{m.invoice_due()}</dt>
						<dd className="font-semibold">¥{amounts.payment_amount}</dd>
					</dl>
				)}
				{error && (
					<p role="alert" className="mt-4 text-destructive text-sm">
						{error}
					</p>
				)}
			</div>
		</main>
	);
}
