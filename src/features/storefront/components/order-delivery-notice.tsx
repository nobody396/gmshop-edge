"use client";

import { Clock3, Copy, Headphones } from "lucide-react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { webSupportOpenEvent } from "#/features/telegram/web-support-contract";
import { m } from "#/paraglide/messages";

type Delivery = {
	id: string;
	type: string;
	status: string;
	supplierState?: string | null;
	fulfillmentSource: "local" | "supplier" | "manual";
	productName: string;
	sellableItemName: string;
};

export function OrderDeliveryNotice({
	deliveries,
	orderNumber,
}: {
	deliveries: Delivery[];
	orderNumber: string;
}) {
	const waiting = deliveries.filter(
		(delivery) =>
			delivery.type === "stock" &&
			["pending", "awaiting_supply", "processing"].includes(delivery.status),
	);
	const manual = waiting.filter(
		(delivery) => delivery.fulfillmentSource === "manual",
	);
	const automatic = deliveries.filter(
		(delivery) =>
			delivery.type === "stock" &&
			delivery.fulfillmentSource !== "manual" &&
			["pending", "awaiting_supply", "processing", "failed"].includes(
				delivery.status,
			),
	);
	const needsReview = automatic.some(
		(delivery) =>
			delivery.status === "failed" || delivery.supplierState === "failed",
	);
	return (
		<>
			{automatic.length ? (
				<section
					data-fulfillment-flow="automatic"
					aria-live="polite"
					className="grid gap-3 rounded-2xl border border-primary/25 bg-primary/5 p-5"
				>
					<div className="flex items-start gap-3">
						<Clock3
							aria-hidden="true"
							className="mt-0.5 size-5 shrink-0 text-primary"
						/>
						<div className="grid gap-1.5">
							<strong>
								{needsReview
									? m.store_automatic_delivery_review_title()
									: m.store_automatic_delivery_pending_title()}
							</strong>
							<p className="text-muted-foreground text-sm">
								{needsReview
									? m.store_automatic_delivery_review_description()
									: m.store_automatic_delivery_pending_description()}
							</p>
						</div>
					</div>
					<ul className="text-muted-foreground text-sm">
						{automatic.map((delivery) => (
							<li key={delivery.id}>
								{delivery.productName} · {delivery.sellableItemName}
							</li>
						))}
					</ul>
				</section>
			) : null}
			{manual.length ? (
				<section
					data-fulfillment-flow="manual"
					className="grid gap-3 rounded-2xl border border-primary/25 bg-primary/5 p-5"
				>
					<div className="flex items-start gap-3">
						<Clock3
							aria-hidden="true"
							className="mt-0.5 size-5 shrink-0 text-primary"
						/>
						<div className="grid gap-1.5">
							<strong>{m.store_activation_code_title()}</strong>
							<p className="text-muted-foreground text-sm">
								{manual.some((delivery) => delivery.status === "processing")
									? m.store_activation_code_processing()
									: m.store_activation_code_description()}
							</p>
						</div>
					</div>
					<ul className="text-muted-foreground text-sm">
						{manual.map((delivery) => (
							<li key={delivery.id}>
								{delivery.productName} · {delivery.sellableItemName}
							</li>
						))}
					</ul>
					<div className="rounded-xl border bg-background p-4">
						<p className="text-muted-foreground text-xs">
							{m.store_activation_code_label()}
						</p>
						<code className="mt-1 block break-all font-semibold text-base">
							{orderNumber}
						</code>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<Button
							variant="outline"
							onClick={() => {
								void navigator.clipboard.writeText(orderNumber);
								toast.success(m.store_activation_code_copied());
							}}
						>
							<Copy />
							{m.store_activation_code_copy()}
						</Button>
						<Button
							onClick={() =>
								window.dispatchEvent(new Event(webSupportOpenEvent))
							}
						>
							<Headphones />
							{m.store_activation_code_support()}
						</Button>
					</div>
					<p className="text-muted-foreground text-xs leading-5">
						{m.store_activation_code_sla()}
					</p>
				</section>
			) : null}
		</>
	);
}
