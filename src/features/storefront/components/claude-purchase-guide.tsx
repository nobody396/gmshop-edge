import { AlertTriangle, ScanSearch, ZoomIn } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "#/components/ui/dialog";
import { m } from "#/paraglide/messages";

export const claudeRechargeProductId = "ba540b83-388d-45d1-9dcb-25c3da3f9956";

export function ClaudePurchaseGuide() {
	return (
		<section
			id="claude-purchase-guide"
			aria-labelledby="claude-purchase-guide-title"
			className="my-10 scroll-mt-24 space-y-6 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 sm:p-8"
		>
			<header className="space-y-2">
				<h2
					id="claude-purchase-guide-title"
					className="flex items-center gap-2 font-semibold text-xl sm:text-2xl"
				>
					<AlertTriangle
						className="size-6 shrink-0 text-amber-600 dark:text-amber-400"
						aria-hidden="true"
					/>
					{m.store_claude_preflight_title()}
				</h2>
				<p className="text-muted-foreground text-sm leading-6">
					{m.store_claude_preflight_intro()}
				</p>
			</header>
			<ol className="grid gap-4">
				<li className="space-y-3 rounded-xl border bg-background p-4 sm:p-5">
					<h3 className="font-semibold">
						{m.store_claude_preflight_subscription_title()}
					</h3>
					<p className="text-sm leading-6">
						{m.store_claude_preflight_subscription_body()}
					</p>
					<GuideImage
						src="/guides/claude/active-subscription.png"
						width={2082}
						height={1176}
						alt={m.store_claude_preflight_subscription_image()}
					/>
				</li>
				<li className="space-y-2 rounded-xl border bg-background p-4 sm:p-5">
					<h3 className="font-semibold">
						{m.store_claude_preflight_billing_title()}
					</h3>
					<p className="text-sm leading-6">
						{m.store_claude_preflight_billing_body()}
					</p>
				</li>
				<li className="space-y-2 rounded-xl border bg-background p-4 sm:p-5">
					<h3 className="font-semibold">
						{m.store_claude_preflight_disabled_title()}
					</h3>
					<p className="text-sm leading-6">
						{m.store_claude_preflight_disabled_body()}
					</p>
				</li>
			</ol>
			<h3 className="flex items-center gap-2 font-semibold text-lg">
				<ScanSearch className="size-5" aria-hidden="true" />
				{m.store_claude_preflight_checks_title()}
			</h3>
			<article className="space-y-3 rounded-xl border bg-background p-4 sm:p-5">
				<h4 className="font-semibold">
					{m.store_claude_preflight_message_title()}
				</h4>
				<p className="text-sm leading-6">
					{m.store_claude_preflight_message_body()}
				</p>
				<p className="break-words rounded-lg bg-muted p-3 font-mono text-sm">
					{m.store_claude_preflight_disabled_error()}
				</p>
				<GuideImage
					src="/guides/claude/message-disabled.png"
					width={2672}
					height={1466}
					alt={m.store_claude_preflight_message_image()}
				/>
			</article>
			<article className="space-y-3 rounded-xl border bg-background p-4 sm:p-5">
				<h4 className="font-semibold">
					{m.store_claude_preflight_upgrade_title()}
				</h4>
				<p className="text-sm leading-6">
					{m.store_claude_preflight_upgrade_body()}
				</p>
				<p className="break-words rounded-lg bg-muted p-3 font-mono text-sm">
					{m.store_claude_preflight_banned_error()}
				</p>
				<GuideImage
					src="/guides/claude/upgrade-disabled.png"
					width={1798}
					height={608}
					alt={m.store_claude_preflight_upgrade_image()}
				/>
			</article>
			<article className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-4 sm:p-5">
				<h3 className="font-semibold text-lg">
					{m.store_claude_preflight_ip_title()}
				</h3>
				<p className="font-semibold text-primary">
					{m.store_claude_preflight_ip_threshold()}
				</p>
				<p className="text-sm leading-6">
					{m.store_claude_preflight_ip_steps()}
				</p>
				<a
					href="https://ip-check.leeguoo.com/"
					target="_blank"
					rel="noopener noreferrer"
					referrerPolicy="no-referrer"
					className="inline-flex rounded-lg border border-primary/30 bg-background px-4 py-2 font-semibold text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
				>
					{m.store_claude_preflight_ip_link()}
				</a>
				<p className="text-muted-foreground text-sm leading-6">
					{m.store_claude_preflight_ip_limits()}
				</p>
			</article>
			<div className="space-y-2 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm leading-6">
				<p className="font-semibold">{m.store_claude_preflight_stop()}</p>
				<p className="text-muted-foreground">
					{m.store_claude_preflight_limits()}
				</p>
			</div>
		</section>
	);
}

function GuideImage({
	src,
	width,
	height,
	alt,
}: {
	src: string;
	width: number;
	height: number;
	alt: string;
}) {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<button
					type="button"
					className="block w-full rounded-xl border bg-muted/30 p-2 text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
					aria-label={m.store_claude_preflight_enlarge({ image: alt })}
				>
					<img
						src={src}
						width={width}
						height={height}
						alt={alt}
						loading="lazy"
						className="mx-auto h-auto max-h-80 w-full rounded-lg object-contain"
					/>
					<span className="mt-2 flex items-center justify-center gap-1 text-muted-foreground text-xs">
						<ZoomIn className="size-3.5" aria-hidden="true" />
						{m.store_claude_preflight_image_hint()}
					</span>
				</button>
			</DialogTrigger>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[calc(100vw-4rem)]">
				<DialogHeader>
					<DialogTitle>{alt}</DialogTitle>
					<DialogDescription>
						{m.store_claude_preflight_image_hint()}
					</DialogDescription>
				</DialogHeader>
				<img
					src={src}
					width={width}
					height={height}
					alt={alt}
					className="mx-auto h-auto max-h-[75dvh] w-auto max-w-full object-contain"
				/>
			</DialogContent>
		</Dialog>
	);
}
