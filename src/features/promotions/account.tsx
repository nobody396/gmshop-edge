import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Clock3,
	Gift,
	Link2,
	type LucideIcon,
	ShoppingBag,
	Sparkles,
	Ticket,
	Users,
	Wallet,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { CategoryChips } from "#/features/home/category-sidebar";
import { formatDateTime, formatMinorAmountWithSymbol } from "#/lib/format";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { promotionAccountQueryKey, ReferralInvite } from "./referral-invite";
import {
	getPromotionAccountFn,
	setMarketingConsentFn,
} from "./server/functions";

const money = (value: string | bigint) =>
	formatMinorAmountWithSymbol(String(value), "CNY", 2);
const minor = (value: string) => (/^-?\d+$/.test(value) ? BigInt(value) : 0n);

export function PromotionAccount() {
	const client = useQueryClient();
	const query = useQuery({
		queryKey: promotionAccountQueryKey,
		queryFn: () => getPromotionAccountFn(),
	});
	const refresh = () =>
		client.invalidateQueries({ queryKey: promotionAccountQueryKey });
	const consent = useMutation({
		mutationFn: (enabled: boolean) =>
			setMarketingConsentFn({ data: { enabled } }),
		onSuccess: refresh,
	});
	const data = query.data;
	const pending = (data?.rewards ?? [])
		.filter((reward) => reward.state === "pending")
		.reduce((sum, reward) => sum + minor(reward.remaining_minor), 0n);
	const earned = (data?.rewards ?? [])
		.filter((reward) => reward.state !== "reversed")
		.reduce((sum, reward) => sum + minor(reward.amount_minor), 0n);
	const invited = (data?.rewards ?? []).filter(
		(reward) => reward.state !== "reversed",
	).length;
	const balance = minor(data?.balanceMinor ?? "0");

	return (
		<section
			aria-label={m.promotion_title()}
			className="my-6 grid gap-5"
			data-testid="promotion-account"
		>
			<div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-5 sm:p-7">
				<Gift
					aria-hidden="true"
					className="pointer-events-none absolute -end-6 -top-6 hidden size-32 text-primary/10 sm:block"
				/>
				<p className="flex items-center gap-1.5 font-medium text-primary text-sm">
					<Sparkles aria-hidden="true" className="size-4" />
					{m.promotion_hero_kicker()}
				</p>
				<h2 className="mt-2 font-bold text-2xl tracking-tight sm:text-3xl">
					{m.promotion_hero_title()}
				</h2>
				<p className="mt-2 max-w-2xl text-muted-foreground text-sm sm:text-base">
					{m.promotion_hero_subtitle()}
				</p>
				<div className="mt-5 max-w-2xl rounded-xl border bg-background/80 p-4 backdrop-blur">
					<ReferralInvite hidePitch />
				</div>
			</div>

			{query.isPending ? (
				<p className="text-muted-foreground text-sm">{m.common_loading()}</p>
			) : query.isError ? (
				<p className="text-destructive text-sm" role="alert">
					{m.promotion_error()}
				</p>
			) : data ? (
				<>
					<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
						<Stat
							emphasis
							hint={balance < 0n ? m.promotion_negative_hint() : undefined}
							icon={Wallet}
							label={m.promotion_stat_available()}
							value={money(balance)}
						/>
						<Stat
							icon={Clock3}
							label={m.promotion_stat_pending()}
							value={money(pending)}
						/>
						<Stat
							icon={Gift}
							label={m.promotion_stat_total()}
							value={money(earned)}
						/>
						<Stat
							icon={Users}
							label={m.promotion_stat_invites()}
							value={String(invited)}
						/>
					</div>

					<Panel title={m.promotion_steps_title()}>
						<ol className="grid gap-3 sm:grid-cols-3">
							<Step icon={Link2} index={1} text={m.promotion_step_share()} />
							<Step
								icon={ShoppingBag}
								index={2}
								text={m.promotion_step_order()}
							/>
							<Step icon={Wallet} index={3} text={m.promotion_step_reward()} />
						</ol>
					</Panel>

					{data.examples?.length ? (
						<Panel
							description={m.promotion_examples_note({
								count: data.examples.length,
							})}
							title={m.promotion_examples_heading()}
						>
							<RewardTable examples={data.examples} />
						</Panel>
					) : null}

					{data.coupons.length ? (
						<Panel title={m.promotion_recall()}>
							<div className="flex flex-wrap gap-2">
								{data.coupons.map((coupon) => (
									<span
										className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1.5 text-sm"
										key={coupon.code}
									>
										<Ticket
											aria-hidden="true"
											className="size-4 text-primary"
										/>
										<code className="whitespace-nowrap font-mono">
											{coupon.code}
										</code>
										<span className="text-muted-foreground text-xs">
											{m.promotion_coupon_until({
												date: formatDateTime(coupon.ends_at),
											})}
										</span>
									</span>
								))}
							</div>
						</Panel>
					) : null}

					<Panel title={m.promotion_rules_title()}>
						<ul className="grid gap-2 text-muted-foreground text-sm">
							{[
								m.promotion_rule_split(),
								m.promotion_rule_timing(),
								m.promotion_rule_cash(),
								m.promotion_rule_limits(),
							].map((rule) => (
								<li className="flex gap-2" key={rule}>
									<span
										aria-hidden="true"
										className="mt-2 size-1.5 shrink-0 rounded-full bg-primary"
									/>
									{rule}
								</li>
							))}
						</ul>
					</Panel>

					<Panel title={m.promotion_history()}>
						{data.rewards.length === 0 && data.entries.length === 0 ? (
							<p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground text-sm">
								{m.promotion_history_empty()}
							</p>
						) : (
							<div className="grid gap-4 lg:grid-cols-2">
								<HistoryList title={m.promotion_history_rewards()}>
									{data.rewards.map((reward) => (
										<li
											className="flex items-center justify-between gap-3 py-2"
											key={reward.order_id}
										>
											<span className="min-w-0 text-muted-foreground text-xs">
												{formatDateTime(reward.created_at)}
											</span>
											<span className="flex shrink-0 items-center gap-2">
												<span className="whitespace-nowrap font-medium tabular-nums">
													{money(reward.amount_minor)}
												</span>
												<RewardState state={reward.state} />
											</span>
										</li>
									))}
								</HistoryList>
								<HistoryList title={m.promotion_history_entries()}>
									{data.entries.map((entry) => (
										<li
											className="flex items-center justify-between gap-3 py-2"
											key={entry.id}
										>
											<span className="min-w-0 text-muted-foreground text-xs">
												{formatDateTime(entry.created_at)}
											</span>
											<span className="flex shrink-0 items-center gap-3 tabular-nums">
												<span
													className={cn(
														"whitespace-nowrap font-medium",
														minor(entry.delta_minor) < 0n
															? "text-destructive"
															: "text-primary",
													)}
												>
													{minor(entry.delta_minor) > 0n ? "+" : ""}
													{money(entry.delta_minor)}
												</span>
												<span className="hidden whitespace-nowrap text-muted-foreground text-xs sm:inline">
													{m.promotion_after_balance({
														amount: money(entry.balance_after_minor),
													})}
												</span>
											</span>
										</li>
									))}
								</HistoryList>
							</div>
						)}
					</Panel>

					{consent.isError ? (
						<p className="text-destructive text-sm" role="alert">
							{m.promotion_error()}
						</p>
					) : null}
					<label className="flex items-start gap-2 px-1 text-muted-foreground text-xs">
						<input
							checked={data.marketingConsent}
							className="mt-0.5"
							disabled={consent.isPending}
							onChange={(event) => consent.mutate(event.target.checked)}
							type="checkbox"
						/>
						{m.promotion_marketing_consent()}
					</label>
				</>
			) : null}
		</section>
	);
}

function Stat({
	emphasis,
	hint,
	icon: Icon,
	label,
	value,
}: {
	emphasis?: boolean;
	hint?: string;
	icon: LucideIcon;
	label: string;
	value: string;
}) {
	return (
		<div
			className={cn(
				"rounded-2xl border p-4",
				emphasis ? "border-primary/30 bg-primary/5" : "bg-card",
			)}
		>
			<p className="flex items-center gap-1.5 text-muted-foreground text-xs">
				<Icon aria-hidden="true" className="size-3.5" />
				{label}
			</p>
			<p
				className={cn(
					"mt-1.5 font-bold text-xl tabular-nums sm:text-2xl",
					emphasis && "text-primary",
				)}
			>
				{value}
			</p>
			{hint ? (
				<p className="mt-1 text-muted-foreground text-xs">{hint}</p>
			) : null}
		</div>
	);
}

function Panel({
	children,
	description,
	title,
}: {
	children: ReactNode;
	description?: string;
	title: string;
}) {
	return (
		<div className="rounded-2xl border bg-card p-4 sm:p-5">
			<h3 className="font-semibold">{title}</h3>
			{description ? (
				<p className="mt-1 text-muted-foreground text-xs">{description}</p>
			) : null}
			<div className="mt-3">{children}</div>
		</div>
	);
}

function Step({
	icon: Icon,
	index,
	text,
}: {
	icon: LucideIcon;
	index: number;
	text: string;
}) {
	return (
		<li className="flex items-start gap-3 rounded-xl bg-muted/40 p-3">
			<span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
				<Icon aria-hidden="true" className="size-4" />
			</span>
			<span className="text-sm">
				<span className="block font-semibold text-primary text-xs">
					{m.promotion_step_label({ index })}
				</span>
				{text}
			</span>
		</li>
	);
}

function HistoryList({
	children,
	title,
}: {
	children: ReactNode;
	title: string;
}) {
	return (
		<div className="rounded-xl border p-3">
			<p className="font-medium text-muted-foreground text-xs">{title}</p>
			<ul className="mt-1 max-h-72 divide-y overflow-y-auto pe-1 text-sm">
				{children}
			</ul>
		</div>
	);
}

function RewardState({ state }: { state: string }) {
	const label =
		state === "pending"
			? m.promotion_pending()
			: state === "available"
				? m.promotion_available()
				: m.promotion_reversed();
	return (
		<span
			className={cn(
				"whitespace-nowrap rounded-full px-2 py-0.5 text-xs",
				state === "pending" &&
					"bg-amber-500/15 text-amber-600 dark:text-amber-400",
				state === "available" && "bg-primary/15 text-primary",
				state !== "pending" &&
					state !== "available" &&
					"bg-muted text-muted-foreground",
			)}
		>
			{label}
		</span>
	);
}

type RewardExample = {
	category?: string;
	name: string;
	discountMinor: string;
	rewardMinor: string;
};

/** Every item that pays a reward, filterable by the storefront's categories, biggest reward first. */
function RewardTable({ examples }: { examples: RewardExample[] }) {
	const [active, setActive] = useState("");
	const counts = new Map<string, number>();
	for (const example of examples) {
		const category = example.category ?? "";
		if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
	}
	const shown = examples
		.filter((example) => !active || example.category === active)
		.sort((a, b) => {
			const diff = minor(b.rewardMinor) - minor(a.rewardMinor);
			return diff > 0n ? 1 : diff < 0n ? -1 : 0;
		});
	return (
		<div className="grid gap-3">
			{counts.size > 1 ? (
				<CategoryChips
					active={active}
					onSelect={setActive}
					tags={[...counts].map(([name, productCount]) => ({
						name,
						productCount,
					}))}
					wrap
				/>
			) : null}
			<div
				className="max-h-[28rem] overflow-y-auto overscroll-contain rounded-xl border"
				data-testid="referral-examples"
			>
				<table className="w-full text-sm">
					<thead className="sticky top-0 bg-muted text-muted-foreground text-xs">
						<tr>
							<th className="px-3 py-2 text-start font-medium">
								{m.promotion_table_product()}
							</th>
							<th className="whitespace-nowrap px-3 py-2 text-end font-medium">
								{m.promotion_table_discount()}
							</th>
							<th className="whitespace-nowrap px-3 py-2 text-end font-medium">
								{m.promotion_table_reward()}
							</th>
						</tr>
					</thead>
					<tbody>
						{shown.map((example) => (
							<tr className="border-t" key={example.name}>
								<td className="px-3 py-2.5">{example.name}</td>
								<td className="whitespace-nowrap px-3 py-2.5 text-end text-muted-foreground tabular-nums">
									{money(example.discountMinor)}
								</td>
								<td className="whitespace-nowrap px-3 py-2.5 text-end font-semibold text-primary tabular-nums">
									{money(example.rewardMinor)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
