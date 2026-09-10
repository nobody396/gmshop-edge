"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackagePlus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { Badge } from "#/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatMinorAmount } from "#/lib/format";
import { formatMinorInput } from "#/lib/money-input";
import { m } from "#/paraglide/messages";
import { importAisouInventoryFn, listAisouInventoryFn } from "../server/admin";

const inventoryKey = ["admin", "aisou-inventory"] as const;
type AisouInventoryRow = Awaited<
	ReturnType<typeof listAisouInventoryFn>
>[number];
type AisouImportInput = Parameters<typeof importAisouInventoryFn>[0]["data"];

export function AisouInventoryAdminPage() {
	const client = useQueryClient();
	const inventory = useQuery({
		queryKey: inventoryKey,
		queryFn: () => listAisouInventoryFn(),
	});
	const importInventory = useMutation({
		mutationFn: importAisouInventoryFn,
		onSuccess: async (result) => {
			await client.invalidateQueries({ queryKey: inventoryKey });
			toast.success(
				m.aisou_inventory_import_result({
					imported: result.imported,
					duplicates: result.duplicates,
				}),
			);
		},
		onError: showError,
	});
	const rows = inventory.data ?? [];

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain pb-6">
			<PageHeader
				title={m.aisou_inventory_title()}
				description={m.aisou_inventory_description()}
				actions={
					<ProButton
						variant="outline"
						disabled={inventory.isFetching}
						onClick={() => inventory.refetch()}
					>
						<RefreshCw />
						{m.common_refresh()}
					</ProButton>
				}
			/>

			<Card className="border-dashed">
				<CardContent className="pt-6 text-sm text-muted-foreground">
					{m.aisou_inventory_pool_notice()}
				</CardContent>
			</Card>

			{inventory.isError ? (
				<Card>
					<CardHeader>
						<CardTitle>{m.aisou_inventory_unavailable()}</CardTitle>
						<CardDescription>{m.common_retry()}</CardDescription>
					</CardHeader>
				</Card>
			) : null}

			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
				{rows.map((row) => {
					const completeCost = row.costedAvailable === row.available;
					return (
						<Card key={row.componentId}>
							<CardHeader className="pb-3">
								<div className="flex items-start justify-between gap-3">
									<div>
										<CardTitle>{row.productName}</CardTitle>
										<CardDescription>{row.itemName}</CardDescription>
									</div>
									<div className="flex shrink-0 flex-col items-end gap-2">
										<Badge
											variant={row.available > 0 ? "default" : "secondary"}
										>
											{row.available > 0
												? m.redeem_warehouse_available()
												: m.redeem_warehouse_empty()}
										</Badge>
										<AisouRestockModal
											row={row}
											onRestock={(data) =>
												importInventory.mutateAsync({ data })
											}
										/>
									</div>
								</div>
							</CardHeader>
							<CardContent className="space-y-3">
								<div className="grid grid-cols-4 gap-2 text-center">
									<Metric
										label={m.redeem_warehouse_available()}
										value={row.available}
									/>
									<Metric
										label={m.aisou_inventory_reserved()}
										value={row.reserved}
									/>
									<Metric
										label={m.aisou_inventory_delivered()}
										value={row.delivered}
									/>
									<Metric
										label={m.aisou_inventory_disabled()}
										value={row.disabled}
									/>
								</div>
								<div className="grid grid-cols-2 gap-3 border-t pt-3 text-sm">
									<div>
										<span className="block text-muted-foreground">
											{m.aisou_inventory_default_unit_cost()}
										</span>
										<strong>
											{row.defaultUnitCostMinor
												? formatMinorAmount(row.defaultUnitCostMinor, "CNY", 2)
												: "—"}
										</strong>
									</div>
									<div>
										<span className="block text-muted-foreground">
											{m.aisou_inventory_available_value()}
										</span>
										<strong>
											{completeCost
												? formatMinorAmount(row.availableValueMinor, "CNY", 2)
												: "—"}
										</strong>
									</div>
								</div>
								{row.lastRestockedAt ? (
									<p className="text-xs text-muted-foreground">
										{m.aisou_inventory_last_restocked()}:{" "}
										{formatDateTime(row.lastRestockedAt)}
									</p>
								) : null}
							</CardContent>
						</Card>
					);
				})}
			</div>
		</div>
	);
}

function AisouRestockModal({
	row,
	onRestock,
}: {
	row: AisouInventoryRow;
	onRestock: (data: AisouImportInput) => Promise<unknown>;
}) {
	return (
		<ModalForm
			title={`${m.aisou_inventory_import()} · ${row.itemName}`}
			trigger={
				<ProButton size="sm" variant="outline">
					<PackagePlus />
					{m.aisou_inventory_quick_restock_short()}
				</ProButton>
			}
			schema={[
				{
					name: "unitCostYuan",
					label: m.redeem_warehouse_unit_cost(),
					valueType: "text",
					required: true,
					fieldProps: { inputMode: "decimal" },
				},
				{
					name: "content",
					label: m.aisou_inventory_cards(),
					valueType: "textarea",
					required: true,
					tooltip: m.aisou_inventory_cards_description(),
					fieldProps: {
						rows: 12,
						autoComplete: "off",
						spellCheck: false,
					},
				},
				{
					name: "usageUrl",
					label: m.inventory_usage_url(),
					valueType: "text",
					required: true,
					fieldProps: { type: "url" },
				},
			]}
			initialValues={{
				unitCostYuan: row.defaultUnitCostMinor
					? formatMinorInput(row.defaultUnitCostMinor, 2)
					: "",
				usageUrl: "https://aiee.fun/",
			}}
			onFinish={async (values) => {
				await onRestock({
					requestRef: `aisou_${crypto.randomUUID()}`,
					componentId: row.componentId,
					unitCostYuan: String(values.unitCostYuan ?? ""),
					content: String(values.content ?? ""),
					usageUrl: String(values.usageUrl ?? ""),
				});
			}}
			onFinishFailed={showError}
		/>
	);
}

function Metric({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-md border bg-muted/20 px-1 py-2">
			<strong className="block text-lg tabular-nums">{value}</strong>
			<span className="text-[11px] text-muted-foreground">{label}</span>
		</div>
	);
}

function showError() {
	toast.error(m.web_support_failed());
}
