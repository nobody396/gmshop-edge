"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { StatusBadge } from "#/components/status-badge";
import { Badge } from "#/components/ui/badge";
import { entitlementStatusLabel } from "#/features/entitlements/labels";
import { shopOrderStatusLabel } from "#/features/shop-orders/labels";
import {
	completeManualShopRefundFn,
	getShopOrderFn,
} from "#/features/shop-orders/server/admin";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatMinorAmount } from "#/lib/format";
import { m } from "#/paraglide/messages";

export function OrderWorkspacePage({ orderId }: { orderId: string }) {
	const [manualRefundId, setManualRefundId] = useState<string | null>(null);
	const order = useQuery({
		queryKey: ["admin", "shop-orders", orderId],
		queryFn: () => getShopOrderFn({ data: { id: orderId } }),
	});
	const completeManualRefund = useMutation({
		mutationFn: completeManualShopRefundFn,
		onSuccess: async () => {
			setManualRefundId(null);
			await order.refetch();
			toast.success(m.shop_orders_manual_refund_completed());
		},
		onError: () => toast.error(m.shop_orders_operation_failed()),
	});
	if (!order.data)
		return <div className="h-96 animate-pulse rounded-2xl bg-muted" />;
	const detail = order.data;
	return (
		<>
			<div className="flex min-h-0 flex-1 flex-col gap-5">
				<PageHeader
					title={detail.orderNumber}
					description={[
						detail.contactEmail,
						shopOrderStatusLabel(detail.status),
					]
						.filter(Boolean)
						.join(" · ")}
					actions={
						<ProButton asChild variant="outline">
							<Link to="/admin/orders">{m.system_nav_orders()}</Link>
						</ProButton>
					}
				/>
				<div className="grid border-y sm:grid-cols-2 xl:grid-cols-4 xl:divide-x">
					<Metric
						label={m.shop_orders_total()}
						value={formatMinorAmount(
							detail.totalMinor,
							detail.currency,
							detail.currencyDecimals,
						)}
					/>
					<Metric
						label={m.shop_orders_paid()}
						value={formatMinorAmount(
							detail.paidMinor,
							detail.currency,
							detail.currencyDecimals,
						)}
					/>
					<Metric
						label={m.shop_orders_created_at()}
						value={formatDateTime(detail.createdAt)}
					/>
					<Metric
						label={m.shop_orders_expires_at()}
						value={formatDateTime(detail.expiresAt)}
					/>
				</div>
				<WorkspaceSection title={m.shop_orders_items()}>
					{detail.items.map((item) => (
						<div
							className="flex flex-wrap items-center justify-between gap-3 border-b py-4 last:border-b-0"
							key={item.id}
						>
							<div>
								<strong>{item.productName}</strong>
								<p className="text-muted-foreground text-sm">
									{item.sellableItemName} · {item.quantity}
								</p>
								<div className="mt-2 flex flex-wrap gap-2">
									<Badge variant="outline">{item.deliveryType}</Badge>
									<Badge variant="outline">
										v{item.deliveryComponentVersion}
									</Badge>
								</div>
								{item.entitlementStatus ? (
									<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
										<span>
											{entitlementStatusLabel(item.entitlementStatus)}
										</span>
										<span>
											{m.store_entitlement_usage()}: {item.usageCount} /{" "}
											{item.currentUsageLimit ?? "∞"}
										</span>
										<span>
											{m.store_entitlement_access()}: {item.accessCount} /{" "}
											{item.currentAccessLimit ?? "∞"}
										</span>
										<span>
											{item.expiresAt ? formatDateTime(item.expiresAt) : "∞"}
										</span>
									</div>
								) : null}
							</div>
							<strong>
								{formatMinorAmount(
									item.subtotalMinor,
									detail.currency,
									detail.currencyDecimals,
								)}
							</strong>
						</div>
					))}
				</WorkspaceSection>
				<div className="grid gap-5 xl:grid-cols-2">
					<WorkspaceSection title={m.shop_orders_payments()}>
						{detail.payments.map((payment) => (
							<div
								className="flex items-center justify-between gap-3 border-b py-3 last:border-b-0"
								key={payment.id}
							>
								<div>
									<strong>{payment.channelName}</strong>
									<p className="text-muted-foreground text-xs">
										{`${formatMinorAmount(payment.amountMinor, payment.currency, payment.currencyDecimals)} · ${payment.exchangeRateSource} ${payment.exchangeRate}`}
									</p>
								</div>
								<StatusBadge value={payment.status} />
							</div>
						))}
					</WorkspaceSection>
					<WorkspaceSection title={m.shop_orders_delivery()}>
						{detail.deliveries.map((delivery) => (
							<div
								className="flex items-center justify-between gap-3 border-b py-3 last:border-b-0"
								key={delivery.id}
							>
								<div>
									<strong>{delivery.productName}</strong>
									<p className="text-muted-foreground text-xs">
										{delivery.type} · {delivery.sellableItemName}
									</p>
								</div>
								<StatusBadge value={delivery.status} />
							</div>
						))}
					</WorkspaceSection>
				</div>
				<div className="grid gap-5 xl:grid-cols-2">
					<WorkspaceSection title={m.shop_orders_refunds()}>
						{detail.refunds.map((refund) => (
							<div
								className="flex items-center justify-between gap-3 border-b py-3 last:border-b-0"
								key={refund.id}
							>
								<div>
									<strong>
										{formatMinorAmount(
											refund.amountMinor,
											refund.currency,
											detail.currencyDecimals,
										)}
									</strong>
									<p className="text-muted-foreground text-xs">
										{refund.reason}
									</p>
									{refund.paymentCurrency !== refund.currency ? (
										<p className="text-muted-foreground text-xs">
											{m.shop_orders_provider_refund_amount()}:{" "}
											{formatMinorAmount(
												refund.paymentAmountMinor,
												refund.paymentCurrency,
												refund.paymentCurrencyDecimals,
											)}
										</p>
									) : null}
								</div>
								<div className="flex items-center gap-2">
									<StatusBadge value={refund.status} />
									{refund.failureCode === "manual_action_required" ? (
										<ProButton
											onClick={() => setManualRefundId(refund.id)}
											size="sm"
										>
											{m.shop_orders_manual_refund_confirm()}
										</ProButton>
									) : null}
								</div>
							</div>
						))}
					</WorkspaceSection>
					<WorkspaceSection title={m.shop_orders_timeline()}>
						{detail.events.map((event) => (
							<div className="border-b py-3 last:border-b-0" key={event.id}>
								<strong className="text-sm">{event.type}</strong>
								<p className="text-muted-foreground text-xs">
									{formatDateTime(event.createdAt)}
								</p>
							</div>
						))}
					</WorkspaceSection>
				</div>
			</div>
			{manualRefundId ? (
				<ModalForm
					key={manualRefundId}
					open
					onOpenChange={(open) => !open && setManualRefundId(null)}
					title={m.shop_orders_manual_refund_confirm()}
					description={m.shop_orders_manual_refund_description()}
					schema={[
						{
							name: "reference",
							label: m.shop_orders_manual_refund_reference(),
							required: true,
						},
						{
							name: "fundsReturned",
							label: m.shop_orders_manual_refund_funds_returned(),
							valueType: "switch" as const,
							description:
								m.shop_orders_manual_refund_funds_returned_description(),
							initialValue: false,
						},
					]}
					onFinish={async (values) => {
						if (values.fundsReturned !== true) {
							toast.error(m.shop_orders_manual_refund_funds_not_returned());
							return;
						}
						await completeManualRefund.mutateAsync({
							data: {
								id: manualRefundId,
								reference: String(values.reference ?? ""),
								fundsReturned: true,
							},
						});
					}}
					onFinishFailed={() => toast.error(m.shop_orders_operation_failed())}
				/>
			) : null}
		</>
	);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div className="p-5">
			<p className="text-muted-foreground text-sm">{label}</p>
			<p className="mt-3 font-semibold text-xl">{value}</p>
		</div>
	);
}

function WorkspaceSection({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="border-t pt-5">
			<h2 className="mb-3 font-semibold text-lg">{title}</h2>
			<div>{children}</div>
		</section>
	);
}
