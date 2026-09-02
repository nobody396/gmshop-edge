"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
	CircleCheck,
	Eye,
	MoreHorizontal,
	Play,
	RotateCcw,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { ProModal } from "#/components/pro/overlay";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { StatusBadge } from "#/components/status-badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	completeManualDeliveryFn,
	listDeliveriesFn,
	retryDeliveryFn,
	revealDeliveryContentFn,
	startManualDeliveryFn,
} from "#/features/fulfillment/server/admin";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type DeliveryPage = Awaited<ReturnType<typeof listDeliveriesFn>>;
type Delivery = DeliveryPage["data"][number];

export function DeliveryCenterPage() {
	const tableUrlState = useCurrentProTableUrlState({
		searchColumnId: "orderNumber",
	});
	const client = useQueryClient();
	const [refreshKey, setRefreshKey] = useState(0);
	const [revealing, setRevealing] = useState<Delivery | null>(null);
	const [completing, setCompleting] = useState<Delivery | null>(null);
	const [revealed, setRevealed] = useState<string | null>(null);
	const refresh = useCallback(() => {
		setRefreshKey((value) => value + 1);
		return client.invalidateQueries({ queryKey: ["admin", "deliveries"] });
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
				queryKey: ["admin", "deliveries", input],
				queryFn: () => listDeliveriesFn({ data: input }),
			});
		},
		[client],
	);
	const retry = useMutation({
		mutationFn: retryDeliveryFn,
		onSuccess: async () => {
			toast.success(m.common_retry());
			await refresh();
		},
		onError: showError,
	});
	const startManual = useMutation({
		mutationFn: startManualDeliveryFn,
		onSuccess: async () => {
			toast.success(m.delivery_manual_start_success());
			await refresh();
		},
		onError: showError,
	});
	const reveal = useMutation({
		mutationFn: revealDeliveryContentFn,
		onSuccess: (result) => {
			setRevealing(null);
			setRevealed(result.content);
		},
		onError: showError,
	});
	const completeManual = useMutation({
		mutationFn: completeManualDeliveryFn,
		onSuccess: async () => {
			setCompleting(null);
			toast.success(m.delivery_manual_complete_success());
			await refresh();
		},
		onError: showError,
	});
	const columns = useMemo<ColumnDef<Delivery>[]>(
		() => [
			{
				accessorKey: "orderNumber",
				header: m.shop_orders_order(),
				meta: { search: true },
			},
			{
				accessorKey: "productName",
				header: m.catalog_product(),
				cell: ({ row }) => (
					<div>
						<strong>{row.original.productName}</strong>
						<p className="text-muted-foreground text-xs">
							{row.original.sellableItemName} · {row.original.deliveryType}
						</p>
					</div>
				),
			},
			{
				accessorKey: "status",
				header: m.common_status(),
				cell: ({ row }) => <StatusBadge value={row.original.status} />,
			},
			{
				accessorKey: "updatedAt",
				header: m.audit_time(),
				cell: ({ row }) => formatDateTime(row.original.updatedAt),
			},
			{
				id: "actions",
				header: m.common_actions(),
				cell: ({ row }) => (
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
							{row.original.status === "awaiting_supply" ? (
								<DropdownMenuItem
									disabled={startManual.isPending}
									onClick={() =>
										startManual.mutate({ data: { id: row.original.id } })
									}
								>
									<Play />
									{m.delivery_manual_start()}
								</DropdownMenuItem>
							) : null}
							{["awaiting_supply", "processing"].includes(
								row.original.status,
							) ? (
								<DropdownMenuItem onClick={() => setCompleting(row.original)}>
									<CircleCheck />
									{m.delivery_manual_complete()}
								</DropdownMenuItem>
							) : null}
							{row.original.status === "failed" ? (
								<DropdownMenuItem
									disabled={retry.isPending}
									onClick={() =>
										retry.mutate({ data: { id: row.original.id } })
									}
								>
									<RotateCcw />
									{m.common_retry()}
								</DropdownMenuItem>
							) : null}
							{row.original.hasContent &&
							row.original.status === "delivered" ? (
								<DropdownMenuItem onClick={() => setRevealing(row.original)}>
									<Eye />
									{m.inventory_reveal()}
								</DropdownMenuItem>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				),
			},
		],
		[retry, startManual],
	);
	return (
		<>
			<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
				<PageHeader
					title={m.delivery_center_title()}
					description={m.delivery_center_description()}
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
			{revealing ? (
				<ModalForm
					key={revealing.id}
					open
					onOpenChange={(open) => !open && setRevealing(null)}
					title={m.inventory_reveal_title()}
					schema={proofFields()}
					onFinish={async (values) => {
						await reveal.mutateAsync({
							data: { id: revealing.id, ...proof(values) },
						});
					}}
					onFinishFailed={showError}
				/>
			) : null}
			{completing ? (
				<ModalForm
					key={completing.id}
					open
					onOpenChange={(open) => !open && setCompleting(null)}
					title={m.delivery_manual_complete_title()}
					schema={[
						{
							name: "content",
							label: m.delivery_manual_content(),
							valueType: "textarea" as const,
							required: true,
						},
					]}
					onFinish={async (values) => {
						await completeManual.mutateAsync({
							data: {
								id: completing.id,
								content: String(values.content ?? ""),
							},
						});
					}}
					onFinishFailed={showError}
				/>
			) : null}
			<ProModal
				open={revealed !== null}
				onOpenChange={(open) => !open && setRevealed(null)}
				title={m.inventory_revealed_title()}
			>
				<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-sm">
					{revealed}
				</pre>
			</ProModal>
		</>
	);
}

function proofFields() {
	return [
		{
			name: "password",
			label: m.common_password(),
			valueType: "password" as const,
			required: true,
		},
	];
}

function proof(values: Record<string, unknown>) {
	return { password: String(values.password ?? "") };
}

function showError() {
	toast.error(m.catalog_operation_failed());
}
