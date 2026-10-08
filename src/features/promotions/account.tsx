import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { formatDateTime, formatMinorAmountWithSymbol } from "#/lib/format";
import { m } from "#/paraglide/messages";
import {
	getPromotionAccountFn,
	openReferralFn,
	setMarketingConsentFn,
} from "./server/functions";

const money = (value: string) => formatMinorAmountWithSymbol(value, "CNY", 2);
export function PromotionAccount() {
	const client = useQueryClient();
	const query = useQuery({
		queryKey: ["promotion-account"],
		queryFn: () => getPromotionAccountFn(),
	});
	const refresh = () =>
		client.invalidateQueries({ queryKey: ["promotion-account"] });
	const open = useMutation({
		mutationFn: () => openReferralFn(),
		onSuccess: refresh,
	});
	const consent = useMutation({
		mutationFn: (enabled: boolean) =>
			setMarketingConsentFn({ data: { enabled } }),
		onSuccess: refresh,
	});
	const data = query.data;
	return (
		<section
			className="my-6 grid gap-4 rounded-xl border p-5"
			aria-label={m.promotion_title()}
		>
			<h2 className="font-semibold text-xl">{m.promotion_title()}</h2>
			<p className="text-sm text-muted-foreground">{m.promotion_rules()}</p>
			{query.isPending ? (
				<p>{m.common_loading()}</p>
			) : query.isError ? (
				<p role="alert">{m.promotion_error()}</p>
			) : data ? (
				<>
					<p>
						{m.promotion_balance()}: <strong>{money(data.balanceMinor)}</strong>
					</p>
					{data.referral ? (
						<>
							<label htmlFor="invitation-code" className="grid gap-2 text-sm">
								{m.promotion_code()}
								<Input
									id="invitation-code"
									value={data.referral.code}
									readOnly
								/>
							</label>
							<Button
								variant="outline"
								disabled={!data.referral.enabled}
								onClick={() => {
									const url = new URL("/", window.location.origin);
									url.searchParams.set("ref", data.referral?.code ?? "");
									void navigator.clipboard.writeText(url.href);
								}}
							>
								{m.promotion_copy_link()}
							</Button>
							{!data.referral.enabled ? <p>{m.promotion_disabled()}</p> : null}
						</>
					) : (
						<Button disabled={open.isPending} onClick={() => open.mutate()}>
							{m.promotion_open()}
						</Button>
					)}
					{open.isError || consent.isError ? (
						<p role="alert">{m.promotion_error()}</p>
					) : null}
					<label className="flex items-start gap-2 text-sm">
						<input
							type="checkbox"
							checked={data.marketingConsent}
							disabled={consent.isPending}
							onChange={(e) => consent.mutate(e.target.checked)}
						/>
						{m.promotion_marketing_consent()}
					</label>
					{data.coupons.map((c) => (
						<p key={c.code}>
							{m.promotion_recall()}: <code>{c.code}</code> ·{" "}
							{formatDateTime(c.ends_at)}
						</p>
					))}
					<details>
						<summary className="cursor-pointer">
							{m.promotion_history()}
						</summary>
						<ul className="mt-3 space-y-2 text-sm">
							{data.rewards.map((r) => (
								<li key={r.order_id}>
									{formatDateTime(r.created_at)} · {money(r.remaining_minor)} ·{" "}
									{r.state === "pending"
										? m.promotion_pending()
										: r.state === "available"
											? m.promotion_available()
											: m.promotion_reversed()}
								</li>
							))}
						</ul>
						<ul className="mt-3 space-y-2 text-sm">
							{data.entries.map((entry) => (
								<li key={entry.id}>
									{formatDateTime(entry.created_at)} ·{" "}
									{money(entry.delta_minor)} · {m.promotion_balance()}:{" "}
									{money(entry.balance_after_minor)}
								</li>
							))}
						</ul>
					</details>
				</>
			) : null}
		</section>
	);
}
