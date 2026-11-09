"use client";

import { ArrowRight, Copy } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { buttonVariants, CopyButton } from "#/components/pro/base/button";
import {
	type DeliveryCode,
	parseStructuredDelivery,
	splitDeliveryMessage,
} from "#/features/storefront/delivery-message";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

const linkClassName =
	"font-medium text-foreground underline decoration-primary underline-offset-4 hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2";

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
	const structured = useMemo(
		() => parseStructuredDelivery(content, usageUrl),
		[content, usageUrl],
	);
	const entry = usageUrl
		? splitDeliveryMessage(usageUrl).find(
				(part) => part.href && part.text === usageUrl,
			)?.href
		: null;

	if (structured) {
		const { codes, redeem, rest } = structured;
		// Keep a separately verified entry visible when it differs from the
		// redeem URL shown as the primary action and from the upstream text.
		const extraEntry =
			entry &&
			entry !== redeem?.href &&
			!splitDeliveryMessage(rest).some((part) => part.href === entry)
				? entry
				: null;
		return (
			<div
				data-delivery-content
				data-delivery-layout="structured"
				className={cn(
					"grid min-w-0 gap-4 rounded-xl border bg-muted/30 p-3 sm:p-4",
					className,
				)}
			>
				<div className="flex min-h-8 items-center justify-between gap-3">
					<p className="font-medium text-sm">{m.store_delivery_your_code()}</p>
					{codes.length > 1 ? (
						<LabelledCopyButton
							copy={codes.map((code) => code.value).join("\n")}
							label={m.store_delivery_copy_all()}
							onCopy={onCopy}
						/>
					) : null}
				</div>
				<ul className="grid gap-2">
					{codes.map((code, index) => (
						<CodeRow
							// biome-ignore lint/suspicious/noArrayIndexKey: codes are static per delivery and may repeat.
							key={index}
							code={code}
							onCopy={onCopy}
						/>
					))}
				</ul>
				{redeem ? (
					<div className="grid gap-2">
						<a
							href={redeem.href}
							target="_blank"
							rel="noopener noreferrer"
							referrerPolicy="no-referrer"
							className={cn(
								buttonVariants({ size: "lg" }),
								"h-11 w-full text-base",
							)}
						>
							{m.store_delivery_open_redeem()}
							<ArrowRight />
						</a>
						<p className="text-center text-muted-foreground text-xs leading-5 [overflow-wrap:anywhere]">
							{redeem.line ? (
								<MessageParts content={redeem.line} />
							) : (
								m.store_delivery_redeem_hint()
							)}
						</p>
					</div>
				) : null}
				{rest ? (
					<div className="min-w-0 border-t pt-3 text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
						<MessageParts content={rest} />
					</div>
				) : null}
				{extraEntry ? <UsageEntry href={extraEntry} /> : null}
			</div>
		);
	}

	const parts = splitDeliveryMessage(content);
	const showEntry = entry && !parts.some((part) => part.href === entry);
	return (
		<div
			data-delivery-content
			data-delivery-layout="raw"
			className={cn(
				"grid min-w-0 gap-3 rounded-xl border bg-muted/30 p-4",
				className,
			)}
		>
			<div className="flex justify-end">
				<LabelledCopyButton
					copy={content}
					label={m.store_delivery_copy_all()}
					onCopy={onCopy}
				/>
			</div>
			<div className="min-w-0 font-mono text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
				<MessageParts content={content} />
			</div>
			{showEntry ? <UsageEntry href={entry} /> : null}
		</div>
	);
}

function CodeRow({
	code,
	onCopy,
}: {
	code: DeliveryCode;
	onCopy?: () => void;
}) {
	return (
		<li className="grid gap-3 rounded-lg border bg-background p-3 sm:flex sm:items-center sm:justify-between sm:gap-4 sm:p-4 dark:bg-background/60">
			<div className="min-w-0">
				<p className="text-muted-foreground text-xs">{code.label}</p>
				<p
					data-delivery-code
					className="mt-1 font-mono font-semibold text-foreground text-[14.5px] leading-7 [overflow-wrap:anywhere] select-all sm:text-xl sm:tracking-wide"
				>
					<HyphenBreaks value={code.value} />
				</p>
			</div>
			<LabelledCopyButton
				className="w-full sm:w-auto"
				copy={code.value}
				label={m.store_delivery_copy_code()}
				onCopy={onCopy}
			/>
		</li>
	);
}

/** Allow line breaks only after hyphens, so a code never splits mid-segment. */
function HyphenBreaks({ value }: { value: string }) {
	const segments = value.split(/(?<=-)/);
	return segments.map((segment, index) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: segments are derived from a static string.
		<Fragment key={index}>
			{index > 0 ? <wbr /> : null}
			{segment}
		</Fragment>
	));
}

function LabelledCopyButton({
	copy,
	label,
	onCopy,
	className,
}: {
	copy: string;
	label: string;
	onCopy?: () => void;
	className?: string;
}) {
	// The CopyButton tooltip never shows on touch screens, so the visible label
	// also confirms the copy. CopyButton calls onClick only after success.
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<CopyButton
			className={className}
			copy={copy}
			icon={<Copy />}
			onClick={() => {
				setCopied(true);
				onCopy?.();
			}}
			size="sm"
			tooltip={label}
			variant="outline"
		>
			<span aria-live="polite">{copied ? m.common_copy_success() : label}</span>
		</CopyButton>
	);
}

function MessageParts({ content }: { content: string }) {
	return splitDeliveryMessage(content).map((part) =>
		part.href ? (
			<a
				key={part.offset}
				href={part.href}
				target="_blank"
				rel="noopener noreferrer"
				referrerPolicy="no-referrer"
				className={linkClassName}
			>
				{part.text}
			</a>
		) : (
			<span key={part.offset}>{part.text}</span>
		),
	);
}

function UsageEntry({ href }: { href: string }) {
	return (
		<div className="grid gap-2 border-t pt-3">
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				referrerPolicy="no-referrer"
				className={cn("w-fit", linkClassName)}
			>
				{m.store_delivery_usage_entry()}
			</a>
			<p className="text-muted-foreground text-sm">
				{m.store_delivery_usage_entry_hint()}
			</p>
		</div>
	);
}
