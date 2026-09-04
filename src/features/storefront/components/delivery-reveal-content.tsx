"use client";

import { useEffect, useRef, useState } from "react";
import { Skeleton } from "#/components/ui/skeleton";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { DeliveryMessage } from "./delivery-message";

export function DeliveryRevealContent({
	deliveryId,
	orderNumber,
	email,
	className,
	skeletonClassName,
}: {
	deliveryId: string;
	orderNumber: string;
	email?: string;
	className?: string;
	skeletonClassName?: string;
}) {
	const requested = useRef(false);
	const [delivery, setDelivery] = useState<{
		content: string;
		usageUrl: string | null;
	} | null>(null);
	const [failed, setFailed] = useState(false);
	const endpoint = `/api/shop/orders/${encodeURIComponent(orderNumber)}/deliveries/${encodeURIComponent(deliveryId)}/reveal`;

	useEffect(() => {
		if (requested.current) return;
		requested.current = true;
		void fetch(endpoint, revealRequest(email))
			.then(async (response) => {
				if (!response.ok) throw new Error("delivery_reveal_failed");
				const body = (await response.json()) as {
					content?: unknown;
					usageUrl?: unknown;
				};
				if (typeof body.content !== "string")
					throw new Error("delivery_reveal_failed");
				setDelivery({
					content: body.content,
					usageUrl: typeof body.usageUrl === "string" ? body.usageUrl : null,
				});
			})
			.catch(() => setFailed(true));
	}, [email, endpoint]);

	if (failed)
		return (
			<p className="text-destructive text-sm">
				{m.store_delivery_reveal_failed()}
			</p>
		);
	if (!delivery)
		return (
			<Skeleton className={cn("h-12 w-full rounded-xl", skeletonClassName)} />
		);
	return (
		<DeliveryMessage
			content={delivery.content}
			usageUrl={delivery.usageUrl}
			className={className}
			onCopy={() => void fetch(endpoint, revealRequest(email, "copied"))}
		/>
	);
}

function revealRequest(email?: string, action?: "copied"): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action, email }),
		credentials: "same-origin",
	};
}
