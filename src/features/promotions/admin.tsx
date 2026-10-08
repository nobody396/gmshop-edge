import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { formatMinorAmountWithSymbol } from "#/lib/format";
import { m } from "#/paraglide/messages";
import { promotionBudgets } from "./pricing";
import {
	issueRecallCouponsFn,
	listPromotionSkusFn,
	previewRecallRecipientsFn,
	setPromotionBudgetFn,
} from "./server/admin";

export function PromotionAdmin({
	onIssued,
}: {
	onIssued: () => Promise<void>;
}) {
	const client = useQueryClient();
	const skus = useQuery({
		queryKey: ["promotion-skus"],
		queryFn: () => listPromotionSkusFn(),
	});
	const save = useMutation({
		mutationFn: setPromotionBudgetFn,
		onSuccess: () => client.invalidateQueries({ queryKey: ["promotion-skus"] }),
	});
	const preview = useMutation({
		mutationFn: () => previewRecallRecipientsFn(),
	});
	const issue = useMutation({
		mutationFn: issueRecallCouponsFn,
		onSuccess: onIssued,
	});
	const [campaign, setCampaign] = useState("");
	const [selected, setSelected] = useState<string[]>([]);
	return (
		<details className="mb-5 rounded-xl border p-4">
			<summary className="cursor-pointer font-semibold">
				{m.promotion_admin_title()}
			</summary>
			<p className="my-3 text-sm text-muted-foreground">
				{m.promotion_admin_rules()}
			</p>
			{skus.isPending ? (
				<p>{m.common_loading()}</p>
			) : skus.isError ? (
				<p role="alert">{m.promotion_error()}</p>
			) : (
				<div className="grid gap-2">
					{skus.data?.map((sku) => (
						<label
							key={sku.id}
							className="flex flex-wrap items-center justify-between gap-2 text-sm"
						>
							<span>{sku.name}</span>
							<select
								aria-label={sku.name}
								className="rounded-md border bg-background p-2"
								value={sku.promotion_budget_minor}
								disabled={save.isPending || sku.currency !== "CNY"}
								onChange={(e) => {
									const value = e.target.value;
									const budget = promotionBudgets.find((b) => b === value);
									if (budget)
										save.mutate({ data: { id: sku.id, budgetMinor: budget } });
								}}
							>
								{promotionBudgets.map((b) => (
									<option key={b} value={b}>
										{formatMinorAmountWithSymbol(b, "CNY", 2)}
									</option>
								))}
							</select>
						</label>
					))}
				</div>
			)}
			<div className="mt-6 grid gap-3 border-t pt-4">
				<h3 className="font-semibold">{m.promotion_recall()}</h3>
				<label htmlFor="recall-campaign" className="grid gap-2">
					{m.promotion_campaign()}
					<Input
						id="recall-campaign"
						value={campaign}
						onChange={(e) => setCampaign(e.target.value)}
						maxLength={80}
					/>
				</label>
				<Button
					variant="outline"
					disabled={preview.isPending}
					onClick={() => {
						issue.reset();
						setSelected([]);
						preview.mutate();
					}}
				>
					{m.promotion_preview_recipients()}
				</Button>
				{preview.data?.length === 0 ? (
					<p>{m.promotion_no_recipients()}</p>
				) : null}
				{preview.data?.map((user) => (
					<label className="flex items-center gap-2 text-sm" key={user.id}>
						<input
							type="checkbox"
							checked={selected.includes(user.id)}
							onChange={(e) =>
								setSelected((current) =>
									e.target.checked
										? [...current, user.id]
										: current.filter((id) => id !== user.id),
								)
							}
						/>
						{user.email}
					</label>
				))}
				<Button
					disabled={!campaign.trim() || !selected.length || issue.isPending}
					onClick={() =>
						issue.mutate({
							data: {
								campaignKey: campaign.trim(),
								userIds: selected,
								startsAt: Date.now(),
							},
						})
					}
				>
					{m.promotion_issue_only()}
				</Button>
				<p className="text-muted-foreground text-sm">
					{m.promotion_no_email()}
				</p>
				{issue.data?.map((c) => (
					<p key={c.id} className="break-all font-mono text-xs">
						{preview.data?.find((u) => u.id === c.userId)?.email} · {c.code}
					</p>
				))}
				{save.isError || preview.isError || issue.isError ? (
					<p role="alert">{m.promotion_error()}</p>
				) : null}
			</div>
		</details>
	);
}
