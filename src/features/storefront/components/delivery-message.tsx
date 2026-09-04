"use client";

import { Copy } from "lucide-react";
import { useMemo } from "react";
import { CopyButton } from "#/components/pro/base/button";
import { splitDeliveryMessage } from "#/features/storefront/delivery-message";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

export function DeliveryMessage({
	content,
	className,
	onCopy,
	usageUrl,
}: {
	content: string;
	className?: string;
	onCopy?: () => void;
	usageUrl?: string | null;
}) {
	const parts = useMemo(() => splitDeliveryMessage(content), [content]);
	const entry = usageUrl
		? splitDeliveryMessage(usageUrl).find(
				(part) => part.href && part.text === usageUrl,
			)?.href
		: null;
	const showEntry = entry && !parts.some((part) => part.href === entry);
	return (
		<div
			data-delivery-content
			className={cn(
				"grid min-w-0 gap-3 rounded-xl border bg-muted/30 p-4",
				className,
			)}
		>
			<div className="flex justify-end">
				<CopyButton
					aria-label={m.store_copy_delivery()}
					copy={content}
					icon={<Copy />}
					onClick={onCopy}
					size="icon-sm"
					tooltip={m.store_copy_delivery()}
					variant="ghost"
				/>
			</div>
			<div className="min-w-0 font-mono text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
				{parts.map((part) =>
					part.href ? (
						<a
							key={part.offset}
							href={part.href}
							target="_blank"
							rel="noopener noreferrer"
							referrerPolicy="no-referrer"
							className="font-medium text-foreground underline decoration-primary underline-offset-4 hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
						>
							{part.text}
						</a>
					) : (
						<span key={part.offset}>{part.text}</span>
					),
				)}
			</div>
			{showEntry ? (
				<div className="grid gap-2 border-t pt-3">
					<a
						href={entry}
						target="_blank"
						rel="noopener noreferrer"
						referrerPolicy="no-referrer"
						className="w-fit font-medium text-foreground underline decoration-primary underline-offset-4 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
					>
						{m.store_delivery_usage_entry()}
					</a>
					<p className="text-muted-foreground text-sm">
						{m.store_delivery_usage_entry_hint()}
					</p>
				</div>
			) : null}
		</div>
	);
}
