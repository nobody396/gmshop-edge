"use client";

import { useQuery } from "@tanstack/react-query";
import {
	ArrowLeft,
	ArrowRight,
	Check,
	ChevronRight,
	ExternalLink,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "#/components/ui/dialog";
import { StoreMoney } from "#/features/exchange-rates/currency-context";
import { getStorefrontProductFn } from "#/features/storefront/server/catalog";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import {
	type GuideStep,
	guideProducts,
	guideProductUrl,
	guideStep,
} from "./buying-guide-rules";

export function BuyingGuide() {
	const [open, setOpen] = useState(false);
	const [answers, setAnswers] = useState<string[]>([]);
	const copy = guideCopy();
	const step = guideStep(answers);
	const focus = useRef<HTMLHeadingElement>(null);
	const path = answers.join("/");
	useEffect(() => {
		if (open && path) focus.current?.focus();
	}, [open, path]);
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				setOpen(value);
				if (!value) setAnswers([]);
			}}
		>
			<DialogTrigger asChild>
				<Button className="buying-guide-breathe w-full rounded-full sm:w-auto">
					{copy.start}
					<ArrowRight className="size-4" />
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[90dvh] overflow-y-auto rounded-2xl p-5 sm:max-w-xl sm:p-7">
				<div className="pr-7">
					<DialogTitle
						ref={focus}
						tabIndex={-1}
						className="text-xl outline-none"
					>
						{step.kind === "question"
							? copy[step.id]
							: step.kind === "stop"
								? copy[step.reason]
								: copy.result}
					</DialogTitle>
					<DialogDescription className="mt-2 leading-6">
						{step.kind === "stop"
							? copy[`${step.reason}_body`]
							: step.kind === "result"
								? step.warning === "overwrite30"
									? copy.overwrite_result_help
									: copy.result_help
								: (copy[`${step.id}_help`] ?? copy.flow_help)}
					</DialogDescription>
				</div>
				{step.kind === "question" ? (
					<>
						{step.help ? <GuideHelp help={step.help} copy={copy} /> : null}
						<div
							className={`grid gap-2 sm:grid-cols-2 ${step.id === "family" ? "grid-cols-2" : ""}`}
						>
							{step.options.map((option) => (
								<button
									type="button"
									key={option}
									onClick={() => setAnswers([...answers, option])}
									className="flex min-h-16 items-center justify-between gap-2 rounded-xl border bg-background p-3 text-left sm:gap-3 sm:p-4 transition-colors hover:border-primary hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-primary"
								>
									<span>
										<span className="block font-semibold text-sm sm:text-base">
											{copy[option]}
										</span>
										{copy[`${option}_hint`] ? (
											<span className="mt-1 block text-muted-foreground text-xs">
												{copy[`${option}_hint`]}
											</span>
										) : null}
									</span>
									<ChevronRight className="hidden size-4 shrink-0 text-muted-foreground sm:block" />
								</button>
							))}
						</div>
					</>
				) : step.kind === "result" ? (
					<GuideResult key={path} step={step} copy={copy} />
				) : null}
				{answers.length ? (
					<div className="flex items-center justify-between border-t pt-3">
						<Button
							variant="ghost"
							onClick={() => setAnswers(answers.slice(0, -1))}
						>
							<ArrowLeft className="size-4" />
							{copy.back}
						</Button>
						<Button variant="ghost" onClick={() => setAnswers([])}>
							{copy.restart}
						</Button>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function GuideHelp({
	help,
	copy,
}: {
	help: "plan" | "billing" | "claude";
	copy: Record<string, string>;
}) {
	const billing = help === "billing";
	const href = billing
		? "https://chatgpt.com/#settings/Billing"
		: help === "claude"
			? "https://claude.ai/"
			: "https://chatgpt.com/";
	const image =
		help === "plan"
			? "/guides/buying/current-plan.png"
			: billing
				? "/guides/buying/billing.png"
				: null;
	return (
		<div className="space-y-3 rounded-xl bg-muted/50 p-4 text-sm leading-6">
			<p>{copy[`${help}_help`]}</p>
			<Button variant="outline" asChild>
				<a href={href} target="_blank" rel="noopener noreferrer">
					{
						copy[
							billing
								? "open_billing"
								: help === "claude"
									? "open_claude"
									: "open_plan"
						]
					}
					<ExternalLink className="size-4" />
				</a>
			</Button>
			{help === "plan" ? (
				<p className="font-medium text-amber-700 dark:text-amber-300">
					{copy.grace}
				</p>
			) : null}
			{billing ? <p>{copy.billing_path}</p> : null}
			{image ? (
				<details>
					<summary className="cursor-pointer font-medium underline underline-offset-4">
						{copy.example}
					</summary>
					<GuideImage
						image={image}
						alt={copy[billing ? "billing_alt" : "plan_alt"] ?? ""}
						copy={copy}
					/>

					{billing ? (
						<p className="mt-2 text-muted-foreground text-xs">
							{copy.billing_note}
						</p>
					) : null}
				</details>
			) : null}
		</div>
	);
}

function GuideImage({
	image,
	alt,
	copy,
}: {
	image: string;
	alt: string;
	copy: Record<string, string>;
}) {
	const [zoomed, setZoomed] = useState(false);
	return (
		<Dialog onOpenChange={() => setZoomed(false)}>
			<DialogTrigger asChild>
				<button
					type="button"
					className="mt-3 block w-full cursor-zoom-in rounded-lg focus-visible:outline-2 focus-visible:outline-primary"
					aria-label={copy.enlarge}
				>
					<img
						src={image}
						loading="lazy"
						className="h-auto w-full rounded-lg"
						alt={alt}
					/>
					<span className="mt-1 block text-center underline">
						{copy.enlarge}
					</span>
				</button>
			</DialogTrigger>
			<DialogContent className="max-h-[95dvh] w-[calc(100%-1rem)] max-w-none gap-3 p-3 sm:max-w-[min(90vw,90rem)] sm:p-5">
				<DialogTitle className="pr-9 text-base">
					{copy.preview_image}
				</DialogTitle>
				<DialogDescription className="sr-only">{alt}</DialogDescription>
				<div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setZoomed(!zoomed)}
					>
						{zoomed ? m.guide_image_fit() : m.guide_image_original()}
					</Button>
				</div>
				<section
					className="max-h-[75dvh] overflow-auto overscroll-contain rounded-lg border"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard scrolling for the enlarged image.
					tabIndex={0}
					aria-label={copy.preview_image}
				>
					<img
						src={image}
						alt={alt}
						className={
							zoomed
								? "h-auto max-w-none"
								: "mx-auto h-auto max-h-[75dvh] max-w-full object-contain"
						}
					/>
				</section>
			</DialogContent>
		</Dialog>
	);
}

function GuideResult({
	step,
	copy,
}: {
	step: Extract<GuideStep, { kind: "result" }>;
	copy: Record<string, string>;
}) {
	const ref = guideProducts[step.product];
	const locale = getLocale();
	const [accepted, setAccepted] = useState(false);
	const product = useQuery({
		queryKey: ["storefront", "product", locale, ref.productId],
		queryFn: () =>
			getStorefrontProductFn({ data: { locale, productId: ref.productId } }),
		staleTime: 0,
		retry: 1,
	});
	if (product.isPending) return <output>{copy.loading}</output>;
	if (product.isError)
		return (
			<div role="alert">
				<p>{copy.load_error}</p>
				<Button
					variant="outline"
					className="mt-3"
					onClick={() => void product.refetch()}
				>
					{copy.retry}
				</Button>
			</div>
		);
	const item = product.data?.sellableItems.find((i) => i.id === ref.itemId);
	if (!item || product.data?.saleDisabled || item.saleDisabled)
		return (
			<output className="block rounded-xl bg-muted p-4">
				{copy.unavailable}
			</output>
		);
	const available =
		item.availableStock < 0 || item.availableStock >= item.minimumQuantity;
	const allowed = available && (!step.warning || accepted);
	return (
		<div className="space-y-4">
			<div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
				<h3 className="font-semibold text-lg">{item.name}</h3>
				<p className="mt-3 font-semibold text-2xl text-primary">
					<StoreMoney
						amountMinor={item.priceMinor}
						currency={item.currency}
						decimals={item.currencyDecimals}
					/>
				</p>
				<output className="mt-2 flex items-center gap-2 text-sm">
					{available ? <Check className="size-4" /> : null}
					{available ? copy.available : copy.sold_out}
				</output>
			</div>
			<div className="space-y-2 text-sm leading-6">
				<h4 className="font-semibold">{copy.policy}</h4>
				{[
					...new Set(
						[
							item.policy.deliveryTime,
							item.policy.coverage,
							item.policy.warranty,
							item.policy.restrictions,
						].filter(Boolean),
					),
				].map((line) => (
					<p className="whitespace-pre-line text-muted-foreground" key={line}>
						{line}
					</p>
				))}
			</div>
			{step.warning ? (
				<div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm leading-6">
					<p>{copy[step.warning]}</p>
					<label className="mt-3 flex cursor-pointer items-start gap-2 font-medium">
						<input
							type="checkbox"
							className="mt-1 size-4 shrink-0 accent-current"
							checked={accepted}
							onChange={(e) => setAccepted(e.target.checked)}
						/>
						{copy[`${step.warning}_accept`]}
					</label>
				</div>
			) : null}
			{allowed ? (
				<Button asChild className="w-full">
					<a href={guideProductUrl(step.product)}>
						{copy.view}
						<ArrowRight className="size-4" />
					</a>
				</Button>
			) : (
				<Button disabled className="w-full">
					{available ? copy.view : copy.sold_out}
				</Button>
			)}
			<p className="text-muted-foreground text-xs">{copy.live_note}</p>
		</div>
	);
}

function guideCopy(): Record<string, string> {
	return {
		start: m.guide_start(),
		family: m.guide_family(),
		gpt: m.guide_gpt(),
		gpt_hint: m.guide_gpt_hint(),
		claude: m.guide_claude(),
		claude_hint: m.guide_claude_hint(),
		points: m.guide_points(),
		points_hint: m.guide_points_hint(),
		sms: m.guide_sms(),
		sms_hint: m.guide_sms_hint(),
		x: m.guide_x(),
		x_hint: m.guide_x_hint(),
		grok: m.guide_grok(),
		grok_hint: m.guide_grok_hint(),
		current: m.guide_current(),
		renew_channel: m.guide_renew_channel(),
		renew_channel_help: m.guide_renew_channel_help(),
		ph_renew: m.guide_ph_renew(),
		ph_renew_hint: m.guide_ph_renew_hint(),

		current_channel: m.guide_current_channel(),
		current_channel_help: m.guide_current_channel_help(),
		current_ph: m.guide_current_ph(),
		current_ph_hint: m.guide_current_ph_hint(),
		current_ios: m.guide_current_ios(),
		current_ios_hint: m.guide_current_ios_hint(),
		current_other: m.guide_current_other(),
		current_other_hint: m.guide_current_other_hint(),
		renew_bill_mismatch: m.guide_renew_bill_mismatch(),
		renew_bill_mismatch_body: m.guide_renew_bill_mismatch_body(),

		gpt_current: m.guide_gpt_current(),
		gpt_current_help: m.guide_gpt_current_help(),
		pro100: m.guide_pro100(),
		pro200: m.guide_pro200(),
		pro500: m.guide_pro500(),
		timing: m.guide_timing(),
		timing_help: m.guide_timing_help(),
		recharge_now: m.guide_recharge_now(),
		recharge_now_hint: m.guide_recharge_now_hint(),
		after_expiry: m.guide_after_expiry(),
		after_expiry_hint: m.guide_after_expiry_hint(),
		channel: m.guide_channel(),
		channel_help: m.guide_channel_help(),
		ph: m.guide_ph(),
		ph_hint: m.guide_ph_hint(),
		ios: m.guide_ios(),
		ios_hint: m.guide_ios_hint(),
		upgrade_channel: m.guide_upgrade_channel(),
		upgrade_channel_help: m.guide_upgrade_channel_help(),
		ph_upgrade: m.guide_ph_upgrade(),
		ph_upgrade_hint: m.guide_ph_upgrade_hint(),
		wait_for_expiry: m.guide_wait_for_expiry(),
		wait_for_expiry_body: m.guide_wait_for_expiry_body(),

		target: m.guide_target(),
		free: m.guide_free(),
		go: m.guide_go(),
		plus: m.guide_plus(),
		pro: m.guide_pro(),
		five: m.guide_five(),
		twenty: m.guide_twenty(),
		fivehundred: m.guide_fivehundred(),
		fivehundred_active: m.guide_fivehundred_active(),
		fivehundred_active_body: m.guide_fivehundred_active_body(),
		plan_help: m.guide_plan_help(),
		grace: m.guide_grace(),
		open_plan: m.guide_open_plan(),
		example: m.guide_example(),
		enlarge: m.guide_enlarge(),
		plan_alt: m.guide_plan_alt(),
		billing_help: m.guide_billing_help(),
		open_billing: m.guide_open_billing(),
		billing_path: m.guide_billing_path(),
		billing_alt: m.guide_billing_alt(),
		billing_note: m.guide_billing_note(),
		pro_php: m.guide_pro_php(),
		yes_8919: m.guide_yes_8919(),
		no_8919: m.guide_no_8919(),
		claude_current: m.guide_claude_current(),
		claude_free: m.guide_claude_free(),
		claude_paid: m.guide_claude_paid(),
		claude_help: m.guide_claude_help(),
		open_claude: m.guide_open_claude(),
		claude_target: m.guide_claude_target(),
		claudepro: m.guide_claudepro(),
		claudefive: m.guide_claudefive(),
		claudetwenty: m.guide_claudetwenty(),
		points_target: m.guide_points_target(),
		points250: m.guide_points250(),
		points500: m.guide_points500(),
		points1000: m.guide_points1000(),
		points2500: m.guide_points2500(),
		sms_target: m.guide_sms_target(),
		smsone: m.guide_smsone(),
		smslong: m.guide_smslong(),
		x_target: m.guide_x_target(),
		xpremium: m.guide_xpremium(),
		xplusmonth: m.guide_xplusmonth(),
		xplusyear: m.guide_xplusyear(),
		result: m.guide_result(),
		result_help: m.guide_result_help(),
		overwrite_result_help: m.guide_overwrite_result_help(),
		view: m.guide_view(),
		back: m.guide_back(),
		restart: m.guide_restart(),
		loading: m.guide_loading(),
		retry: m.guide_retry(),
		load_error: m.guide_load_error(),
		unavailable: m.guide_unavailable(),
		sold_out: m.guide_sold_out(),
		available: m.guide_available(),
		live_note: m.guide_live_note(),
		policy: m.guide_policy(),
		overwrite: m.guide_overwrite(),
		overwrite30: m.guide_overwrite30(),
		overwrite30_accept: m.guide_overwrite30_accept(),
		overwrite_accept: m.guide_overwrite_accept(),
		kyc: m.guide_kyc(),
		kyc_accept: m.guide_kyc_accept(),
		upgrade_pending: m.guide_upgrade_pending(),
		upgrade_pending_body: m.guide_upgrade_pending_body(),
		free_points: m.guide_free_points(),
		free_points_body: m.guide_free_points_body(),
		claude_active: m.guide_claude_active(),
		claude_active_body: m.guide_claude_active_body(),
		rule_pending: m.guide_rule_pending(),
		rule_pending_body: m.guide_rule_pending_body(),
		preview_image: m.guide_preview_image(),
		flow_help: m.guide_flow_help(),
	};
}
