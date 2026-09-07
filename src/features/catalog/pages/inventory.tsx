"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, Download, Eye, MoreHorizontal, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { Switch as ProSwitch } from "#/components/pro/base/fields/checkbox";
import { ModalForm } from "#/components/pro/form";
import { ProModal } from "#/components/pro/overlay";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { catalogOperationErrorMessage } from "#/features/catalog/error-message";
import {
	catalogOptionsQuery,
	catalogOptionsQueryKey,
} from "#/features/catalog/queries";
import {
	deleteInventoryFn,
	exportInventoryFn,
	importInventoryFn,
	listInventoryFn,
	revealInventorySecretFn,
	setInventoryStatusFn,
} from "#/features/catalog/server/admin";
import { ConfirmDialog } from "#/layouts/components/confirm-dialog";
import { formatDateTime } from "#/lib/format";
import { m } from "#/paraglide/messages";

type InventoryPage = Awaited<ReturnType<typeof listInventoryFn>>;
type Inventory = InventoryPage["data"][number];

export function ProductInventory({
	productId,
	componentId,
}: {
	productId: string;
	componentId?: string;
}) {
	const client = useQueryClient();
	const options = useQuery(catalogOptionsQuery);
	const [refreshKey, setRefreshKey] = useState(0);
	const [revealing, setRevealing] = useState<Inventory | null>(null);
	const [revealed, setRevealed] = useState<{
		id: string;
		secret: string;
	} | null>(null);
	const [deleting, setDeleting] = useState<Inventory | null>(null);
	const refresh = useCallback(async () => {
		await Promise.all([
			client.invalidateQueries({ queryKey: ["admin", "catalog", "inventory"] }),
			client.invalidateQueries({ queryKey: catalogOptionsQueryKey }),
		]);
		setRefreshKey((value) => value + 1);
	}, [client]);
	const request = useCallback(
		(state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "secretMask")
					?.value ?? "",
			);
			const input = {
				pageIndex: state.pagination.pageIndex,
				pageSize: state.pagination.pageSize,
				search,
				productId,
				componentId,
			};
			return client.fetchQuery({
				queryKey: ["admin", "catalog", "inventory", input],
				queryFn: () => listInventoryFn({ data: input }),
			});
		},
		[client, productId, componentId],
	);
	const importSecrets = useMutation({
		mutationFn: importInventoryFn,
		onSuccess: async (result) => {
			toast.success(
				m.inventory_import_result({
					imported: result.imported,
					duplicates: result.duplicates,
				}),
			);
			await refresh();
		},
		onError: showError,
	});
	const setStatus = useMutation({
		mutationFn: setInventoryStatusFn,
		onSuccess: refresh,
		onError: showError,
	});
	const reveal = useMutation({
		mutationFn: revealInventorySecretFn,
		onSuccess: (result) => {
			setRevealing(null);
			setRevealed(result);
		},
		onError: showError,
	});
	const remove = useMutation({
		mutationFn: deleteInventoryFn,
		onSuccess: async () => {
			setDeleting(null);
			await refresh();
		},
		onError: showError,
	});
	const exportInventory = useMutation({
		mutationFn: exportInventoryFn,
		onSuccess: (result) => downloadCsv(result.filename, result.content),
		onError: showError,
	});
	const columns = useMemo<ColumnDef<Inventory>[]>(
		() => [
			{
				accessorKey: "secretMask",
				header: m.inventory_secret(),
				meta: { search: true },
				cell: ({ row }) => (
					<code className="font-mono text-sm">{row.original.secretMask}</code>
				),
			},
			{
				accessorKey: "productName",
				header: m.catalog_product(),
				cell: ({ row }) => (
					<div>
						<strong className="block">{row.original.productName}</strong>
						<span className="text-muted-foreground text-xs">
							{row.original.sellableItemName}
						</span>
					</div>
				),
			},
			{
				accessorKey: "status",
				header: m.common_status(),
				cell: ({ row }) => (
					<Badge
						variant={
							row.original.status === "available" ? "default" : "secondary"
						}
					>
						{inventoryStatusLabel(row.original.status)}
					</Badge>
				),
			},
			{
				accessorKey: "note",
				header: m.inventory_note(),
				cell: ({ row }) => row.original.note ?? "—",
			},
			{
				accessorKey: "createdAt",
				header: m.common_created(),
				cell: ({ row }) => formatDateTime(row.original.createdAt),
			},
			{
				id: "actions",
				header: m.common_actions(),
				cell: ({ row }) => {
					const mutable =
						row.original.status === "available" ||
						row.original.status === "disabled";
					return (
						<div className="flex items-center justify-end gap-2">
							<ProSwitch
								aria-label={`${m.common_enabled()} · ${row.original.secretMask}`}
								disabled={!mutable || setStatus.isPending}
								onChange={(enabled) =>
									setStatus.mutate({
										data: {
											id: row.original.id,
											status: enabled ? "available" : "disabled",
										},
									})
								}
								value={row.original.status === "available"}
							/>
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
									<DropdownMenuItem onClick={() => setRevealing(row.original)}>
										<Eye />
										{m.inventory_reveal()}
									</DropdownMenuItem>
									<DropdownMenuItem
										variant="destructive"
										disabled={!mutable}
										onClick={() => setDeleting(row.original)}
									>
										<Trash2 />
										{m.common_delete()}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					);
				},
			},
		],
		[setStatus],
	);
	const cardItems = (options.data?.sellableItems ?? []).filter(
		(sellableItem, index, rows) =>
			sellableItem.deliveryType === "stock" &&
			sellableItem.productId === productId &&
			sellableItem.deliveryComponentId &&
			(!componentId || sellableItem.deliveryComponentId === componentId) &&
			rows.findIndex(
				(item) => item.deliveryComponentId === sellableItem.deliveryComponentId,
			) === index,
	);

	return (
		<>
			<div className="flex min-h-0 w-full flex-1 flex-col">
				<ProTable
					className="min-h-0 flex-1"
					columns={columns}
					request={request}
					requestKey={refreshKey}
					onRefresh={refresh}
					toolbar={
						<div className="flex flex-wrap gap-2">
							<ModalForm
								title={m.audit_export()}
								trigger={
									<ProButton
										disabled={cardItems.length === 0}
										variant="outline"
									>
										<Download />
										{m.audit_export()}
									</ProButton>
								}
								schema={[
									...(componentId
										? []
										: [
												{
													name: "componentId",
													label: m.catalog_sellable_item(),
													valueType: "select" as const,
													required: true,
													fieldProps: {
														options: sellableItemOptions(cardItems),
													},
												},
											]),
									...sensitiveProofFields(),
								]}
								onFinish={async (values) => {
									await exportInventory.mutateAsync({
										data: {
											componentId:
												componentId ?? String(values.componentId ?? ""),
											...sensitiveProof(values),
										},
									});
								}}
								onFinishFailed={showError}
							/>
							<ModalForm
								title={m.inventory_import()}
								trigger={
									<ProButton disabled={cardItems.length === 0}>
										{m.inventory_import()}
									</ProButton>
								}
								schema={[
									...(componentId
										? []
										: [
												{
													name: "componentId",
													label: m.catalog_sellable_item(),
													valueType: "select" as const,
													required: true,
													fieldProps: {
														options: sellableItemOptions(cardItems),
														searchable: true,
													},
												},
											]),
									{
										name: "content",
										label: m.inventory_content(),
										valueType: "textarea" as const,
										required: true,
										tooltip: m.inventory_content_description(),
										fieldProps: { rows: 12 },
									},
									{
										name: "note",
										label: m.inventory_note(),
										valueType: "textarea" as const,
									},
									{
										name: "usageUrl",
										label: m.inventory_usage_url(),
										valueType: "text" as const,
										tooltip: m.inventory_usage_url_description(),
										fieldProps: {
											placeholder: "https://example.com/redeem",
											type: "url",
										},
									},
								]}
								onFinish={async (values) => {
									await importSecrets.mutateAsync({
										data: {
											componentId:
												componentId ?? String(values.componentId ?? ""),
											content: String(values.content ?? ""),
											note: String(values.note ?? ""),
											usageUrl: String(values.usageUrl ?? ""),
										},
									});
								}}
								onFinishFailed={showError}
							/>
						</div>
					}
					toolbarSearch={{
						columnId: "secretMask",
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
					description={m.inventory_reveal_description()}
					schema={sensitiveProofFields()}
					onFinish={async (values) => {
						await reveal.mutateAsync({
							data: { id: revealing.id, ...sensitiveProof(values) },
						});
					}}
					onFinishFailed={showError}
				/>
			) : null}
			<ProModal
				open={Boolean(revealed)}
				onOpenChange={(open) => !open && setRevealed(null)}
				title={m.inventory_revealed_title()}
				description={m.inventory_revealed_description()}
			>
				<div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
					<code className="min-w-0 flex-1 break-all font-mono text-sm">
						{revealed?.secret}
					</code>
					<ProButton
						size="icon-sm"
						variant="outline"
						tooltip={m.common_copy()}
						onClick={() => copySecret(revealed?.secret)}
					>
						<Copy />
					</ProButton>
				</div>
			</ProModal>
			<ConfirmDialog
				open={Boolean(deleting)}
				onOpenChange={(open) => !open && setDeleting(null)}
				title={m.inventory_delete_title()}
				desc={m.inventory_delete_description({
					mask: deleting?.secretMask ?? "",
				})}
				confirmText={m.common_delete()}
				destructive
				isLoading={remove.isPending}
				handleConfirm={() =>
					deleting && remove.mutate({ data: { id: deleting.id } })
				}
			/>
		</>
	);
}

function sensitiveProofFields() {
	return [
		{
			name: "password",
			label: m.common_password(),
			valueType: "password" as const,
			required: true,
			description: m.account_change_password_old_password_required(),
		},
	];
}

function sensitiveProof(values: Record<string, unknown>) {
	return { password: String(values.password ?? "") };
}

function sellableItemOptions(
	sellableItems: Array<{
		deliveryComponentId: string;
		productName: string;
		name: string;
	}>,
) {
	return sellableItems.map((sellableItem) => ({
		value: sellableItem.deliveryComponentId,
		label: `${sellableItem.productName} · ${sellableItem.name}`,
	}));
}

function downloadCsv(filename: string, content: string) {
	const url = URL.createObjectURL(
		new Blob([content], { type: "text/csv;charset=utf-8" }),
	);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	URL.revokeObjectURL(url);
}

function inventoryStatusLabel(status: Inventory["status"]) {
	if (status === "available") return m.inventory_status_available();
	if (status === "reserved") return m.inventory_status_reserved();
	if (status === "delivered") return m.inventory_status_delivered();
	return m.inventory_status_disabled();
}

async function copySecret(secret: string | undefined) {
	if (!secret) return;
	try {
		await navigator.clipboard.writeText(secret);
		toast.success(m.common_copy_success());
	} catch {
		toast.error(m.common_copy_failed());
	}
}

function showError(error: unknown) {
	toast.error(catalogOperationErrorMessage(error));
}
