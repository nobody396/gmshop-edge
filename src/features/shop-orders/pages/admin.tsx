"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
	Banknote,
	Eye,
	MoreHorizontal,
	NotebookPen,
	Workflow,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { ProModal } from "#/components/pro/overlay";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { StatusBadge, statusLabel } from "#/components/status-badge";
import { Badge } from "#/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { afterSaleNextStatuses } from "#/features/shop-orders/after-sale-status";
import { ManualRefundConfirmationModal } from "#/features/shop-orders/components/manual-refund-confirmation-modal";
import { shopOrderOperationErrorMessage } from "#/features/shop-orders/error-message";
import { shopOrderStatusLabel } from "#/features/shop-orders/labels";
import {
	type AfterSaleStatus,
	type ShopOrderStatus,
	shopOrderStatuses,
} from "#/features/shop-orders/schema";
import {
	getShopOrderFn,
	listShopOrdersFn,
	requestShopRefundFn,
	retryShopRefundFn,
	saveShopOrderAdminNoteFn,
	transitionShopOrderFn,
	updateAfterSaleCaseFn,
} from "#/features/shop-orders/server/admin";
import { canTransitionShopOrder } from "#/features/shop-orders/status";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatMinorAmount, formatNumber } from "#/lib/format";
import { formatMinorInput, parseMajorInput } from "#/lib/money-input";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type OrderPageResult = Awaited<ReturnType<typeof listShopOrdersFn>>;
type Order = OrderPageResult["data"][number];
type OrderDetail = Awaited<ReturnType<typeof getShopOrderFn>>;

export function ShopOrdersPage() {
	const tableUrlState = useCurrentProTableUrlState({
		searchColumnId: "orderNumber",
	});
	const client = useQueryClient();
	const [refreshKey, setRefreshKey] = useState(0);
	const [detail, setDetail] = useState<OrderDetail | null>(null);
	const [editingNote, setEditingNote] = useState<Order | null>(null);
	const [transition, setTransition] = useState<{
		order: Order;
		toStatus: ShopOrderStatus;
	} | null>(null);
	const [refundingOrder, setRefundingOrder] = useState<Order | null>(null);
	const [manualRefundId, setManualRefundId] = useState<string | null>(null);
	const [afterSaleCase, setAfterSaleCase] = useState<
		OrderDetail["afterSales"][number] | null
	>(null);
	const refresh = useCallback(async () => {
		await client.invalidateQueries({ queryKey: ["admin", "shop-orders"] });
		setRefreshKey((value) => value + 1);
	}, [client]);
	const request = useCallback(
		(state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "orderNumber")
					?.value ?? "",
			);
			const input = {
				pageIndex: state.pagination.pageIndex,
				pageSize: state.pagination.pageSize,
				search,
			};
			return client.fetchQuery({
				queryKey: ["admin", "shop-orders", input],
				queryFn: () => listShopOrdersFn({ data: input }),
			});
		},
		[client],
	);
	const loadDetail = useMutation({
		mutationFn: getShopOrderFn,
		onSuccess: setDetail,
		onError: showError,
	});
	const saveNote = useMutation({
		mutationFn: saveShopOrderAdminNoteFn,
		onSuccess: async () => {
			setEditingNote(null);
			await refresh();
		},
		onError: showError,
	});
	const changeStatus = useMutation({
		mutationFn: transitionShopOrderFn,
		onSuccess: async () => {
			setTransition(null);
			setDetail(null);
			await refresh();
		},
		onError: showError,
	});
	const refund = useMutation({
		mutationFn: requestShopRefundFn,
		onSuccess: async (result) => {
			setRefundingOrder(null);
			setDetail(null);
			await refresh();
			toast.success(
				result.manualActionRequired
					? m.shop_orders_refund_manual_pending()
					: m.shop_orders_refund_queued(),
			);
		},
		onError: showError,
	});
	const updateAfterSale = useMutation({
		mutationFn: updateAfterSaleCaseFn,
		onSuccess: async () => {
			setAfterSaleCase(null);
			setDetail(null);
			await refresh();
			toast.success(m.shop_orders_after_sale_updated());
		},
		onError: showError,
	});
	const retryRefund = useMutation({
		mutationFn: retryShopRefundFn,
		onSuccess: async () => {
			setDetail(null);
			await refresh();
			toast.success(m.shop_orders_refund_queued());
		},
		onError: showError,
	});
	const columns = useMemo<ColumnDef<Order>[]>(
		() => [
			{
				accessorKey: "orderNumber",
				header: m.shop_orders_order(),
				meta: { search: true },
				cell: ({ row }) => (
					<div>
						<Link
							className="block font-mono font-medium hover:underline"
							params={{ orderId: row.original.id }}
							to="/admin/orders/$orderId"
						>
							{row.original.orderNumber}
						</Link>
						<span className="text-muted-foreground text-xs">
							{formatDateTime(row.original.createdAt)}
						</span>
						{row.original.source === "supplier_api" ? (
							<Badge className="ms-2" variant="outline">
								{m.shop_orders_source_api()}
							</Badge>
						) : null}
					</div>
				),
			},
			{
				accessorKey: "status",
				header: m.common_status(),
				cell: ({ row }) => (
					<Badge variant={orderStatusVariant(row.original.status)}>
						{shopOrderStatusLabel(row.original.status)}
					</Badge>
				),
			},
			{
				accessorKey: "contactEmail",
				header: m.shop_orders_customer(),
				cell: ({ row }) => (
					<div>
						<span className="block">
							{row.original.userName || m.customers_guest()}
						</span>
						<span className="text-muted-foreground text-xs">
							{row.original.contactEmail}
						</span>
					</div>
				),
			},
			{
				accessorKey: "itemCount",
				header: m.shop_orders_items(),
				cell: ({ row }) => formatNumber(row.original.itemCount),
			},
			{
				accessorKey: "totalMinor",
				header: m.shop_orders_total(),
				cell: ({ row }) =>
					formatMinorAmount(
						row.original.totalMinor,
						row.original.currency,
						row.original.currencyDecimals,
					),
			},
			{
				id: "delivery",
				header: m.shop_orders_delivery(),
				cell: ({ row }) =>
					row.original.deliveryFailedCount ? (
						<Badge variant="destructive">
							{m.shop_orders_failed_count({
								count: row.original.deliveryFailedCount,
							})}
						</Badge>
					) : row.original.deliveryPendingCount ? (
						<Badge variant="secondary">
							{m.shop_orders_pending_count({
								count: row.original.deliveryPendingCount,
							})}
						</Badge>
					) : (
						"—"
					),
			},
			{
				id: "actions",
				header: m.common_actions(),
				cell: ({ row }) => {
					const nextStatuses = shopOrderStatuses.filter((status) =>
						canTransitionShopOrder(row.original.status, status),
					);
					const refundable = [
						"paid",
						"fulfilling",
						"completed",
						"failed",
					].includes(row.original.status);
					return (
						<div className="flex justify-end">
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<ProButton
										size="icon-sm"
										variant="ghost"
										tooltip={m.common_actions()}
									>
										<MoreHorizontal />
									</ProButton>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										disabled={loadDetail.isPending}
										onClick={() =>
											loadDetail.mutate({ data: { id: row.original.id } })
										}
									>
										<Eye />
										{m.shop_orders_view()}
									</DropdownMenuItem>
									{refundable ? (
										<DropdownMenuItem
											onClick={() => setRefundingOrder(row.original)}
										>
											<Banknote />
											{m.shop_orders_refund()}
										</DropdownMenuItem>
									) : null}
									<DropdownMenuItem
										onClick={() => setEditingNote(row.original)}
									>
										<NotebookPen />
										{m.shop_orders_edit_note()}
									</DropdownMenuItem>
									{nextStatuses.length ? <DropdownMenuSeparator /> : null}
									{nextStatuses.map((status) => (
										<DropdownMenuItem
											key={status}
											onClick={() =>
												setTransition({ order: row.original, toStatus: status })
											}
										>
											<Workflow />
											{m.shop_orders_move_to({
												status: shopOrderStatusLabel(status),
											})}
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					);
				},
			},
		],
		[loadDetail],
	);

	return (
		<>
			<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
				<PageHeader
					title={m.system_nav_orders()}
					description={m.shop_orders_description()}
				/>
				<ProTable
					initialState={tableUrlState.initialState}
					onChange={tableUrlState.onChange}
					className="min-h-0 flex-1"
					columns={columns}
					request={request}
					requestKey={refreshKey}
					onRefresh={refresh}
					toolbarSearch={{
						columnId: "orderNumber",
						placeholder: m.common_search(),
					}}
					table={{ stickyHeader: true }}
				/>
			</div>
			{editingNote ? (
				<ModalForm
					key={editingNote.id}
					open
					onOpenChange={(open) => !open && setEditingNote(null)}
					title={m.shop_orders_edit_note()}
					schema={[
						{
							name: "note",
							label: m.shop_orders_admin_note(),
							valueType: "textarea" as const,
						},
					]}
					initialValues={{ note: editingNote.adminNote ?? "" }}
					onFinish={async (values) => {
						await saveNote.mutateAsync({
							data: { id: editingNote.id, note: String(values.note ?? "") },
						});
					}}
					onFinishFailed={showError}
				/>
			) : null}
			{transition ? (
				<ModalForm
					key={`${transition.order.id}-${transition.toStatus}`}
					open
					onOpenChange={(open) => !open && setTransition(null)}
					title={m.shop_orders_transition_title({
						status: shopOrderStatusLabel(transition.toStatus),
					})}
					description={m.shop_orders_transition_description({
						order: transition.order.orderNumber,
					})}
					schema={[
						{
							name: "note",
							label: m.shop_orders_operation_note(),
							valueType: "textarea" as const,
						},
					]}
					onFinish={async (values) => {
						await changeStatus.mutateAsync({
							data: {
								id: transition.order.id,
								version: transition.order.version,
								toStatus: transition.toStatus,
								note: String(values.note ?? ""),
							},
						});
					}}
					onFinishFailed={showError}
				/>
			) : null}
			<OrderDetailModal
				detail={detail}
				onOpenChange={(open) => !open && setDetail(null)}
				onManageAfterSale={setAfterSaleCase}
				onRetryRefund={(id) => retryRefund.mutate({ data: { id } })}
				onConfirmManualRefund={(id) => {
					setDetail(null);
					setManualRefundId(id);
				}}
			/>
			<ManualRefundConfirmationModal
				refundId={manualRefundId}
				onOpenChange={(open) => !open && setManualRefundId(null)}
				onCompleted={async () => {
					setDetail(null);
					await refresh();
				}}
			/>
			{refundingOrder ? (
				<ModalForm
					key={refundingOrder.id}
					open
					onOpenChange={(open) => !open && setRefundingOrder(null)}
					title={m.shop_orders_refund()}
					description={refundingOrder.orderNumber}
					schema={[
						{
							name: "amount",
							label: m.shop_orders_refund_amount({
								currency: refundingOrder.currency,
							}),
							description: m.shop_orders_refund_amount_description(),
							required: true,
						},
						{
							name: "reason",
							label: m.shop_orders_refund_reason(),
							valueType: "textarea" as const,
							required: true,
						},
					]}
					initialValues={{
						amount: formatMinorInput(
							refundingOrder.paidMinor,
							refundingOrder.currencyDecimals,
						),
						reason: "",
					}}
					onFinish={async (values) => {
						const amountMinor = parseMajorInput(
							String(values.amount ?? ""),
							refundingOrder.currencyDecimals,
						);
						if (!amountMinor || amountMinor === "0") {
							toast.error(m.shop_orders_refund_amount_invalid());
							return;
						}
						await refund.mutateAsync({
							data: {
								orderId: refundingOrder.id,
								amountMinor,
								reason: String(values.reason ?? ""),
								idempotencyKey: crypto.randomUUID(),
							},
						});
					}}
					onFinishFailed={showError}
				/>
			) : null}
			{afterSaleCase ? (
				<ModalForm
					key={afterSaleCase.id}
					open
					onOpenChange={(open) => !open && setAfterSaleCase(null)}
					title={m.shop_orders_after_sale_manage()}
					description={afterSaleCase.caseNumber}
					schema={[
						{
							name: "status",
							label: m.common_status(),
							valueType: "select" as const,
							required: true,
							fieldProps: {
								options: afterSaleNextStatuses(
									afterSaleCase.status as AfterSaleStatus,
								).map((status) => ({
									value: status,
									label: statusLabel(status),
								})),
							},
						},
						{
							name: "resolution",
							label: m.shop_orders_after_sale_resolution(),
							valueType: "textarea" as const,
						},
						{
							name: "note",
							label: m.shop_orders_operation_note(),
							valueType: "textarea" as const,
						},
					]}
					initialValues={{
						status:
							afterSaleNextStatuses(
								afterSaleCase.status as AfterSaleStatus,
							)[0] ?? "closed",
						resolution: "",
						note: "",
					}}
					onFinish={async (values) => {
						await updateAfterSale.mutateAsync({
							data: {
								id: afterSaleCase.id,
								status: String(values.status) as AfterSaleStatus,
								resolution: String(values.resolution ?? ""),
								note: String(values.note ?? ""),
							},
						});
					}}
					onFinishFailed={showError}
				/>
			) : null}
		</>
	);
}

function OrderDetailModal({
	detail,
	onOpenChange,
	onManageAfterSale,
	onRetryRefund,
	onConfirmManualRefund,
}: {
	detail: OrderDetail | null;
	onOpenChange: (open: boolean) => void;
	onManageAfterSale: (afterSale: OrderDetail["afterSales"][number]) => void;
	onRetryRefund: (id: string) => void;
	onConfirmManualRefund: (id: string) => void;
}) {
	return (
		<ProModal
			open={Boolean(detail)}
			onOpenChange={onOpenChange}
			title={detail?.orderNumber ?? m.shop_orders_order()}
			description={
				detail
					? [detail.contactEmail, shopOrderStatusLabel(detail.status)]
							.filter(Boolean)
							.join(" · ")
					: undefined
			}
			className="sm:max-w-4xl"
		>
			{detail ? (
				<div className="grid gap-5 overflow-y-auto">
					<div className="grid gap-3 sm:grid-cols-4">
						<Summary
							label={m.shop_orders_total()}
							value={formatMinorAmount(
								detail.totalMinor,
								detail.currency,
								detail.currencyDecimals,
							)}
						/>
						<Summary
							label={m.shop_orders_paid()}
							value={formatMinorAmount(
								detail.paidMinor,
								detail.currency,
								detail.currencyDecimals,
							)}
						/>
						<Summary
							label={m.shop_orders_created_at()}
							value={formatDateTime(detail.createdAt)}
						/>
						<Summary
							label={m.shop_orders_expires_at()}
							value={formatDateTime(detail.expiresAt)}
						/>
					</div>
					<DetailSection title={m.shop_orders_items()}>
						{detail.items.map((item) => (
							<DetailRow
								key={item.id}
								title={`${item.productName} · ${item.sellableItemName}`}
								meta={`${item.quantity} × ${formatMinorAmount(item.unitPriceMinor, detail.currency, detail.currencyDecimals)}`}
								value={formatMinorAmount(
									item.subtotalMinor,
									detail.currency,
									detail.currencyDecimals,
								)}
							/>
						))}
					</DetailSection>
					<DetailSection title={m.shop_orders_payments()}>
						{detail.payments.length ? (
							detail.payments.map((payment) => (
								<DetailRow
									key={payment.id}
									title={`${payment.channelName} · ${payment.provider}`}
									meta={`${formatDateTime(payment.createdAt)} · ${payment.exchangeRateSource} ${payment.exchangeRate}`}
									value={`${formatMinorAmount(payment.amountMinor, payment.currency, payment.currencyDecimals)} · ${statusLabel(payment.status)}`}
								/>
							))
						) : (
							<Empty />
						)}
					</DetailSection>
					<DetailSection title={m.shop_orders_delivery()}>
						{detail.deliveries.length ? (
							detail.deliveries.map((delivery) => (
								<div
									key={delivery.id}
									className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border p-3 text-sm"
								>
									<div>
										<strong className="block">{`${delivery.productName} · ${delivery.sellableItemName}`}</strong>
										<span className="text-muted-foreground text-xs">{`${delivery.type} · ${formatDateTime(delivery.createdAt)}`}</span>
									</div>
									<StatusBadge value={delivery.status} />
								</div>
							))
						) : (
							<Empty />
						)}
					</DetailSection>
					<DetailSection title={m.shop_orders_refunds()}>
						{detail.refunds.length ? (
							detail.refunds.map((refund) => (
								<div
									key={refund.id}
									className="flex items-center justify-between gap-3 rounded-lg border p-3"
								>
									<div className="text-sm">
										<strong>
											{formatMinorAmount(
												refund.amountMinor,
												refund.currency,
												detail.currencyDecimals,
											)}
										</strong>
										<p className="text-muted-foreground text-xs">
											{`${refund.reason} · ${formatDateTime(refund.createdAt)}`}
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
										{refund.status === "failed" ? (
											<ProButton
												onClick={() => onRetryRefund(refund.id)}
												size="sm"
											>
												{m.common_retry()}
											</ProButton>
										) : null}
										{refund.failureCode === "manual_action_required" ? (
											<ProButton
												onClick={() => onConfirmManualRefund(refund.id)}
												size="sm"
											>
												{m.shop_orders_manual_refund_confirm()}
											</ProButton>
										) : null}
									</div>
								</div>
							))
						) : (
							<Empty />
						)}
					</DetailSection>
					<DetailSection title={m.shop_orders_after_sales()}>
						{detail.afterSales.length ? (
							detail.afterSales.map((afterSale) => (
								<div
									key={afterSale.id}
									className="flex items-center justify-between gap-3 rounded-lg border p-3"
								>
									<div className="min-w-0 text-sm">
										<strong>{`${afterSale.caseNumber} · ${afterSale.type}`}</strong>
										<p className="truncate text-muted-foreground text-xs">
											{`${afterSale.reason} · ${formatDateTime(afterSale.createdAt)}`}
										</p>
									</div>
									<div className="flex items-center gap-2">
										<StatusBadge value={afterSale.status} />
										{afterSale.status !== "closed" ? (
											<ProButton
												onClick={() => onManageAfterSale(afterSale)}
												size="sm"
											>
												{m.shop_orders_after_sale_manage()}
											</ProButton>
										) : null}
									</div>
								</div>
							))
						) : (
							<Empty />
						)}
					</DetailSection>
					<DetailSection title={m.shop_orders_timeline()}>
						{detail.events.length ? (
							detail.events.map((event) => (
								<DetailRow
									key={event.id}
									title={
										event.fromStatus && event.toStatus
											? `${shopOrderStatusLabel(event.fromStatus)} → ${shopOrderStatusLabel(event.toStatus)}`
											: event.type
									}
									meta={`${event.actorType} · ${formatDateTime(event.createdAt)}${timelineNote(event.type, event.note)}`}
									value={event.version ? `v${event.version}` : ""}
								/>
							))
						) : (
							<Empty />
						)}
					</DetailSection>
				</div>
			) : null}
		</ProModal>
	);
}

function timelineNote(type: string, note: string | null) {
	if (!note) return "";
	return ` · ${type === "refund_failed" ? m.store_account_notification_refund_failed() : note}`;
}

function DetailSection({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="grid gap-2">
			<h3 className="font-semibold">{title}</h3>
			<div className="grid gap-2">{children}</div>
		</section>
	);
}
function DetailRow({
	title,
	meta,
	value,
}: {
	title: string;
	meta: string;
	value: string;
}) {
	return (
		<div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-lg border p-3 text-sm">
			<div>
				<strong className="block">{title}</strong>
				<span className="text-muted-foreground text-xs">{meta}</span>
			</div>
			<span>{value}</span>
		</div>
	);
}
function Summary({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg border p-3">
			<span className="text-muted-foreground text-xs">{label}</span>
			<strong className="mt-1 block">{value}</strong>
		</div>
	);
}
function Empty() {
	return <p className="text-muted-foreground text-sm">—</p>;
}

function orderStatusVariant(status: ShopOrderStatus) {
	if (status === "completed" || status === "paid") return "default" as const;
	if (status === "failed" || status === "refunded")
		return "destructive" as const;
	return "secondary" as const;
}

function showError(error: unknown) {
	toast.error(shopOrderOperationErrorMessage(error));
}
