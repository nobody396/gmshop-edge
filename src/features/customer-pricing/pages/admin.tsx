"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	deleteCustomerPriceFn,
	deleteVolumeStepFn,
	listPricingAdminFn,
	saveCustomerPriceFn,
	saveVolumeStepFn,
} from "#/features/customer-pricing/server/admin";
import { PageHeader } from "#/layouts/components/page-header";
import { formatMinorAmountWithSymbol } from "#/lib/format";
import { m } from "#/paraglide/messages";

type PricingData = Awaited<ReturnType<typeof listPricingAdminFn>>;

const queryKey = ["admin", "customer-pricing"] as const;
const money = (minor: string) => formatMinorAmountWithSymbol(minor, "CNY", 2);

/** "113" / "113.5" → minor units; null when not a plain amount. */
function toMinor(value: string) {
	const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim());
	if (!match) return null;
	return (
		BigInt(match[1] ?? "0") * 100n +
		BigInt((match[2] ?? "").padEnd(2, "0"))
	).toString();
}

const errorMessages: Record<string, () => string> = {
	customer_price_customer_missing: () => m.pricing_admin_error_customer(),
	customer_price_alipay_missing: () => m.pricing_admin_error_alipay(),
	pricing_discount_invalid: () => m.pricing_admin_error_discount(),
};

function errorMessage(error: unknown) {
	const code =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
	return errorMessages[code]?.() ?? m.pricing_admin_save_failed();
}

export function CustomerPricingPage() {
	const pricing = useQuery({
		queryKey,
		queryFn: () => listPricingAdminFn(),
	});
	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				description={m.pricing_admin_description()}
				title={m.nav_customer_pricing()}
			/>
			{pricing.isError ? (
				<p className="text-destructive text-sm">
					{m.pricing_admin_load_failed()}
				</p>
			) : !pricing.data ? (
				<p className="text-muted-foreground text-sm">{m.common_loading()}</p>
			) : (
				<div className="grid gap-6">
					<VolumeStepsCard data={pricing.data} />
					<CustomerPricesCard data={pricing.data} />
				</div>
			)}
		</div>
	);
}

function ItemSelect({
	id,
	items,
	value,
	onChange,
}: {
	id: string;
	items: PricingData["items"];
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<select
			className="h-9 w-full rounded-md border bg-background px-3 text-sm"
			id={id}
			onChange={(event) => onChange(event.target.value)}
			required
			value={value}
		>
			<option value="">{m.pricing_admin_choose_plan()}</option>
			{items.map((item) => (
				<option key={item.id} value={item.id}>
					{item.label}（{money(item.priceMinor)}）
				</option>
			))}
		</select>
	);
}

function VolumeStepsCard({ data }: { data: PricingData }) {
	const client = useQueryClient();
	const fieldId = useId();
	const [itemId, setItemId] = useState("");
	const [minQuantity, setMinQuantity] = useState("");
	const [discount, setDiscount] = useState("");
	const labels = new Map(data.items.map((item) => [item.id, item]));
	const refresh = () => client.invalidateQueries({ queryKey });
	const save = useMutation({
		mutationFn: saveVolumeStepFn,
		onSuccess: async () => {
			setMinQuantity("");
			setDiscount("");
			await refresh();
			toast.success(m.pricing_admin_saved());
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const remove = useMutation({
		mutationFn: deleteVolumeStepFn,
		onSuccess: refresh,
		onError: (error) => toast.error(errorMessage(error)),
	});
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const discountMinor = toMinor(discount);
		const quantity = Number(minQuantity);
		if (
			!itemId ||
			!discountMinor ||
			!Number.isInteger(quantity) ||
			quantity < 2
		) {
			toast.error(m.pricing_admin_invalid());
			return;
		}
		save.mutate({ data: { itemId, minQuantity: quantity, discountMinor } });
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>{m.pricing_admin_volume_title()}</CardTitle>
				<CardDescription>
					{m.pricing_admin_volume_description()}
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4">
				<div className="overflow-x-auto">
					<table className="w-full min-w-[32rem] text-sm">
						<thead className="text-left text-muted-foreground text-xs">
							<tr>
								<th className="py-2 pr-3 font-medium">
									{m.pricing_admin_plan()}
								</th>
								<th className="py-2 pr-3 font-medium">
									{m.pricing_admin_from_quantity()}
								</th>
								<th className="py-2 pr-3 font-medium">
									{m.pricing_admin_discount()}
								</th>
								<th className="py-2 pr-3 font-medium">
									{m.pricing_admin_unit_price()}
								</th>
								<th className="py-2 font-medium" />
							</tr>
						</thead>
						<tbody>
							{data.volumeSteps.length === 0 ? (
								<tr>
									<td className="py-3 text-muted-foreground" colSpan={5}>
										{m.pricing_admin_empty()}
									</td>
								</tr>
							) : (
								data.volumeSteps.map((step) => {
									const item = labels.get(step.itemId);
									return (
										<tr
											className="border-t"
											key={`${step.itemId}:${step.minQuantity}`}
										>
											<td className="py-2 pr-3">
												{item?.label ?? step.itemId}
											</td>
											<td className="py-2 pr-3 tabular-nums">
												{step.minQuantity}
											</td>
											<td className="py-2 pr-3 tabular-nums">
												−{money(step.discountMinor)}
											</td>
											<td className="py-2 pr-3 tabular-nums">
												{item
													? money(
															(
																BigInt(item.priceMinor) -
																BigInt(step.discountMinor)
															).toString(),
														)
													: "—"}
											</td>
											<td className="py-2 text-right">
												<Button
													aria-label={m.pricing_admin_delete()}
													disabled={remove.isPending}
													onClick={() =>
														remove.mutate({
															data: {
																itemId: step.itemId,
																minQuantity: step.minQuantity,
															},
														})
													}
													size="icon"
													variant="ghost"
												>
													<Trash2 />
												</Button>
											</td>
										</tr>
									);
								})
							)}
						</tbody>
					</table>
				</div>
				<form
					className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end"
					onSubmit={submit}
				>
					<div className="grid gap-1.5">
						<Label htmlFor={`${fieldId}-item`}>{m.pricing_admin_plan()}</Label>
						<ItemSelect
							id={`${fieldId}-item`}
							items={data.items}
							onChange={setItemId}
							value={itemId}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor={`${fieldId}-quantity`}>
							{m.pricing_admin_from_quantity()}
						</Label>
						<Input
							id={`${fieldId}-quantity`}
							inputMode="numeric"
							onChange={(event) => setMinQuantity(event.target.value)}
							placeholder="10"
							value={minQuantity}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor={`${fieldId}-discount`}>
							{m.pricing_admin_discount()}
						</Label>
						<Input
							id={`${fieldId}-discount`}
							inputMode="decimal"
							onChange={(event) => setDiscount(event.target.value)}
							placeholder="1"
							value={discount}
						/>
					</div>
					<Button disabled={save.isPending} type="submit">
						{m.pricing_admin_save()}
					</Button>
				</form>
			</CardContent>
		</Card>
	);
}

function CustomerPricesCard({ data }: { data: PricingData }) {
	const client = useQueryClient();
	const fieldId = useId();
	const [email, setEmail] = useState("");
	const [itemId, setItemId] = useState("");
	const [minQuantity, setMinQuantity] = useState("1");
	const [price, setPrice] = useState("");
	const [alipay, setAlipay] = useState("");
	const refresh = () => client.invalidateQueries({ queryKey });
	const save = useMutation({
		mutationFn: saveCustomerPriceFn,
		onSuccess: async () => {
			setPrice("");
			setAlipay("");
			await refresh();
			toast.success(m.pricing_admin_saved());
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	const remove = useMutation({
		mutationFn: deleteCustomerPriceFn,
		onSuccess: refresh,
		onError: (error) => toast.error(errorMessage(error)),
	});
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const priceMinor = toMinor(price);
		const alipayMinor = alipay.trim() ? toMinor(alipay) : null;
		const quantity = Number(minQuantity);
		if (
			!email.trim() ||
			!itemId ||
			!priceMinor ||
			(alipay.trim() && !alipayMinor) ||
			!Number.isInteger(quantity) ||
			quantity < 1
		) {
			toast.error(m.pricing_admin_invalid());
			return;
		}
		save.mutate({
			data: {
				email: email.trim(),
				itemId,
				minQuantity: quantity,
				priceMinor,
				alipayMinor,
			},
		});
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>{m.pricing_admin_customer_title()}</CardTitle>
				<CardDescription>
					{m.pricing_admin_customer_description()}
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4">
				<div className="overflow-x-auto">
					<table className="w-full min-w-[40rem] text-sm">
						<thead className="text-left text-muted-foreground text-xs">
							<tr>
								<th className="py-2 pr-3 font-medium">
									{m.pricing_admin_customer()}
								</th>
								<th className="py-2 pr-3 font-medium">
									{m.pricing_admin_plan()}
								</th>
								<th className="py-2 pr-3 font-medium">
									{m.pricing_admin_from_quantity()}
								</th>
								<th className="py-2 pr-3 font-medium">USDT</th>
								<th className="py-2 pr-3 font-medium">
									{m.pricing_admin_alipay()}
								</th>
								<th className="py-2 pr-3 font-medium">
									{m.pricing_admin_cost()}
								</th>
								<th className="py-2 font-medium" />
							</tr>
						</thead>
						<tbody>
							{data.customerPrices.length === 0 ? (
								<tr>
									<td className="py-3 text-muted-foreground" colSpan={7}>
										{m.pricing_admin_empty()}
									</td>
								</tr>
							) : (
								data.customerPrices.map((row) => (
									<tr className="border-t" key={row.id}>
										<td className="py-2 pr-3">{row.email}</td>
										<td className="py-2 pr-3">{row.itemLabel}</td>
										<td className="py-2 pr-3 tabular-nums">
											{row.minQuantity}
										</td>
										<td className="py-2 pr-3 tabular-nums">
											{money(row.priceMinor)}
										</td>
										<td className="py-2 pr-3 tabular-nums">
											{money(row.alipayMinor)}
										</td>
										<td className="py-2 pr-3 tabular-nums">
											{row.costMinor ? money(row.costMinor) : "—"}
										</td>
										<td className="py-2 text-right">
											<Button
												aria-label={m.pricing_admin_delete()}
												disabled={remove.isPending}
												onClick={() =>
													remove.mutate({
														data: {
															userId: row.userId,
															itemId: row.itemId,
															minQuantity: row.minQuantity,
														},
													})
												}
												size="icon"
												variant="ghost"
											>
												<Trash2 />
											</Button>
										</td>
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
				<form
					className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.5fr_2fr_0.7fr_1fr_1fr_auto] lg:items-end"
					onSubmit={submit}
				>
					<div className="grid gap-1.5">
						<Label htmlFor={`${fieldId}-email`}>
							{m.pricing_admin_customer()}
						</Label>
						<Input
							autoComplete="off"
							id={`${fieldId}-email`}
							onChange={(event) => setEmail(event.target.value)}
							placeholder="name@example.com"
							type="email"
							value={email}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor={`${fieldId}-item`}>{m.pricing_admin_plan()}</Label>
						<ItemSelect
							id={`${fieldId}-item`}
							items={data.items}
							onChange={setItemId}
							value={itemId}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor={`${fieldId}-quantity`}>
							{m.pricing_admin_from_quantity()}
						</Label>
						<Input
							id={`${fieldId}-quantity`}
							inputMode="numeric"
							onChange={(event) => setMinQuantity(event.target.value)}
							value={minQuantity}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor={`${fieldId}-price`}>USDT</Label>
						<Input
							id={`${fieldId}-price`}
							inputMode="decimal"
							onChange={(event) => setPrice(event.target.value)}
							placeholder="115"
							value={price}
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor={`${fieldId}-alipay`}>
							{m.pricing_admin_alipay_optional()}
						</Label>
						<Input
							id={`${fieldId}-alipay`}
							inputMode="decimal"
							onChange={(event) => setAlipay(event.target.value)}
							value={alipay}
						/>
					</div>
					<Button disabled={save.isPending} type="submit">
						{m.pricing_admin_save()}
					</Button>
				</form>
			</CardContent>
		</Card>
	);
}
