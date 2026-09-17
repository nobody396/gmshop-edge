"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackagePlus, RefreshCw, Settings, Zap } from "lucide-react";
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
import { catalogOptionsQuery } from "#/features/catalog/queries";
import { PageHeader } from "#/layouts/components/page-header";
import { m } from "#/paraglide/messages";
import {
	generateRedeemSellableInventoryFn,
	getRedeemWarehouseConfigurationFn,
	importRedeemWarehouseInventoryFn,
	listRedeemRestockTargetsFn,
	listRedeemWarehouseInventoryFn,
	quickRestockRedeemWarehouseFn,
	saveRedeemWarehouseConfigurationFn,
} from "../server/admin";

const configurationKey = [
	"admin",
	"redeem-warehouse",
	"configuration",
] as const;
const inventoryKey = ["admin", "redeem-warehouse", "inventory"] as const;
const targetsKey = ["admin", "redeem-warehouse", "targets"] as const;

export function RedeemWarehouseAdminPage() {
	const client = useQueryClient();
	const configuration = useQuery({
		queryKey: configurationKey,
		queryFn: () => getRedeemWarehouseConfigurationFn(),
	});
	const inventory = useQuery({
		queryKey: inventoryKey,
		queryFn: () => listRedeemWarehouseInventoryFn(),
		enabled: configuration.data?.configured === true,
	});
	const catalog = useQuery(catalogOptionsQuery);
	const restockTargets = useQuery({
		queryKey: targetsKey,
		queryFn: () => listRedeemRestockTargetsFn(),
		enabled: configuration.data?.configured === true,
	});
	const quickRestock = useMutation({
		mutationFn: quickRestockRedeemWarehouseFn,
		onSuccess: async (result) => {
			await client.invalidateQueries({ queryKey: inventoryKey });
			await client.invalidateQueries({ queryKey: targetsKey });
			if (result.generationFailed)
				toast.warning(
					m.redeem_warehouse_quick_restock_partial({
						imported: result.imported,
					}),
				);
			else if (result.imported === 0)
				toast.warning(
					m.redeem_warehouse_quick_restock_none({ total: result.total }),
				);
			else
				toast.success(
					m.redeem_warehouse_quick_restock_result({
						total: result.total,
						imported: result.imported,
						generated: result.generated,
					}),
				);
		},
		onError: showError,
	});
	const saveConfiguration = useMutation({
		mutationFn: saveRedeemWarehouseConfigurationFn,
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: configurationKey });
			await client.invalidateQueries({ queryKey: inventoryKey });
			toast.success(m.redeem_warehouse_configuration_saved());
		},
		onError: showError,
	});
	const importInventory = useMutation({
		mutationFn: importRedeemWarehouseInventoryFn,
		onSuccess: async (result) => {
			await client.invalidateQueries({ queryKey: inventoryKey });
			toast.success(
				m.redeem_warehouse_import_result({
					imported: result.imported,
					total: result.total,
				}),
			);
		},
		onError: showError,
	});
	const generateSellable = useMutation({
		mutationFn: generateRedeemSellableInventoryFn,
		onSuccess: (result) => {
			toast.success(
				m.redeem_warehouse_sellable_result({
					imported: result.imported,
					count: result.count,
				}),
			);
		},
		onError: showError,
	});
	const rows = inventory.data ?? [];
	const stockItems = (catalog.data?.sellableItems ?? []).filter(
		(item) => item.deliveryType === "stock",
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain pb-6">
			<PageHeader
				title={m.redeem_warehouse_title()}
				description={m.redeem_warehouse_description()}
				actions={
					<>
						<ProButton
							variant="outline"
							disabled={!configuration.data?.configured || inventory.isFetching}
							onClick={() => inventory.refetch()}
						>
							<RefreshCw />
							{m.common_refresh()}
						</ProButton>
						<ModalForm
							title={m.redeem_warehouse_configuration()}
							trigger={
								<ProButton variant="outline">
									<Settings />
									{m.redeem_warehouse_configuration()}
								</ProButton>
							}
							schema={[
								{
									name: "token",
									label: m.redeem_warehouse_token(),
									valueType: "password",
									required: !configuration.data?.configured,
									tooltip: m.redeem_warehouse_token_description(),
								},
							]}
							initialValues={{ token: "" }}
							onFinish={async (values) => {
								await saveConfiguration.mutateAsync({
									data: {
										...(values.token ? { token: String(values.token) } : {}),
									},
								});
							}}
							onFinishFailed={showError}
						/>
						<ModalForm
							title={m.redeem_warehouse_import()}
							trigger={
								<ProButton
									disabled={
										!configuration.data?.configured || rows.length === 0
									}
								>
									<PackagePlus />
									{m.redeem_warehouse_import()}
								</ProButton>
							}
							schema={[
								{
									name: "sku",
									label: "SKU",
									valueType: "select",
									required: true,
									fieldProps: {
										options: rows.map((row) => ({
											label: `${row.displayName} · ${row.sku}`,
											value: row.sku,
										})),
										searchable: true,
									},
								},
								{
									name: "unitCostYuan",
									label: m.redeem_warehouse_unit_cost(),
									valueType: "text",
									fieldProps: { inputMode: "decimal", placeholder: "132.00" },
								},
								{
									name: "content",
									label: m.redeem_warehouse_keys(),
									valueType: "textarea",
									required: true,
									tooltip: m.redeem_warehouse_keys_description(),
									fieldProps: {
										rows: 12,
										autoComplete: "off",
										spellCheck: false,
									},
								},
							]}
							onFinish={async (values) => {
								await importInventory.mutateAsync({
									data: {
										sku: String(values.sku ?? ""),
										unitCostYuan:
											String(values.unitCostYuan ?? "") || undefined,
										content: String(values.content ?? ""),
									},
								});
							}}
							onFinishFailed={showError}
						/>
						<ModalForm
							title={m.redeem_warehouse_generate_sellable()}
							trigger={
								<ProButton
									variant="outline"
									disabled={
										!configuration.data?.configured ||
										rows.length === 0 ||
										stockItems.length === 0
									}
								>
									<PackagePlus />
									{m.redeem_warehouse_generate_sellable()}
								</ProButton>
							}
							schema={[
								{
									name: "sku",
									label: "兑换 SKU",
									valueType: "select",
									required: true,
									fieldProps: {
										options: rows.map((row) => ({
											label: `${row.displayName} · ${row.sku}`,
											value: row.sku,
										})),
										searchable: true,
									},
								},
								{
									name: "componentId",
									label: m.redeem_warehouse_target_item(),
									valueType: "select",
									required: true,
									fieldProps: {
										options: stockItems.map((item) => ({
											label: `${item.productName} · ${item.name}`,
											value: item.deliveryComponentId,
										})),
										searchable: true,
									},
								},
								{
									name: "count",
									label: m.redeem_warehouse_generate_count(),
									valueType: "text",
									required: true,
									fieldProps: { type: "number", min: 1, max: 100 },
								},
							]}
							initialValues={{ count: 20 }}
							onFinish={async (values) => {
								await generateSellable.mutateAsync({
									data: {
										requestRef: `redeem_${crypto.randomUUID()}`,
										sku: String(values.sku ?? ""),
										componentId: String(values.componentId ?? ""),
										count: Number(values.count),
									},
								});
							}}
							onFinishFailed={showError}
						/>
					</>
				}
			/>

			{!configuration.isLoading && !configuration.data?.configured ? (
				<Card>
					<CardHeader>
						<CardTitle>{m.redeem_warehouse_not_configured()}</CardTitle>
						<CardDescription>
							{m.redeem_warehouse_not_configured_description()}
						</CardDescription>
					</CardHeader>
				</Card>
			) : null}
			{inventory.isError ? (
				<Card>
					<CardHeader>
						<CardTitle>{m.redeem_warehouse_unavailable()}</CardTitle>
						<CardDescription>
							{m.redeem_warehouse_unavailable_description()}
						</CardDescription>
					</CardHeader>
				</Card>
			) : null}
			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
				{rows.map((row) => (
					<Card key={row.sku}>
						<CardHeader className="pb-3">
							<div className="flex items-start justify-between gap-3">
								<div>
									<CardTitle>{row.displayName}</CardTitle>
									<CardDescription className="font-mono text-xs">
										{row.sku}
									</CardDescription>
								</div>
								<Badge variant={row.available > 0 ? "default" : "secondary"}>
									{row.available > 0
										? m.redeem_warehouse_available()
										: row.assigned > 0
											? m.redeem_warehouse_assigned()
											: m.redeem_warehouse_empty()}
								</Badge>
							</div>
						</CardHeader>
						<CardContent className="flex items-center justify-between gap-3 pb-3 text-sm">
							<div className="min-w-0">
								<div className="text-muted-foreground text-xs">
									{m.redeem_warehouse_feeds()}
								</div>
								{row.target ? (
									<div className="truncate">
										{row.target.productName} · {row.target.itemName}
										<span className="ml-2 text-muted-foreground">
											{m.redeem_warehouse_storefront_available({
												count: row.target.available,
											})}
										</span>
									</div>
								) : (
									<div className="text-muted-foreground">
										{m.redeem_warehouse_feeds_none()}
									</div>
								)}
							</div>
							<ModalForm
								title={`${m.redeem_warehouse_quick_restock()} · ${row.displayName}`}
								description={m.redeem_warehouse_quick_restock_description()}
								trigger={
									<ProButton
										size="sm"
										disabled={(restockTargets.data ?? []).length === 0}
									>
										<Zap />
										{m.redeem_warehouse_quick_restock()}
									</ProButton>
								}
								schema={[
									{
										name: "componentId",
										label: m.redeem_warehouse_restock_target(),
										valueType: "select",
										required: true,
										tooltip: m.redeem_warehouse_restock_target_description(),
										fieldProps: {
											options: (restockTargets.data ?? []).map((item) => ({
												label: `${item.productName} · ${item.itemName}`,
												value: item.componentId,
											})),
											searchable: true,
										},
									},
									{
										name: "unitCostYuan",
										label: m.redeem_warehouse_unit_cost(),
										valueType: "text",
										fieldProps: {
											inputMode: "decimal",
											placeholder: "1600.00",
										},
									},
									{
										name: "content",
										label: m.redeem_warehouse_keys(),
										valueType: "textarea",
										required: true,
										tooltip: m.redeem_warehouse_keys_description(),
										fieldProps: {
											rows: 8,
											autoComplete: "off",
											spellCheck: false,
										},
									},
								]}
								initialValues={{
									componentId: row.target?.componentId ?? "",
								}}
								onFinish={async (values) => {
									await quickRestock.mutateAsync({
										data: {
											requestRef: `restock_${crypto.randomUUID()}`,
											sku: row.sku,
											componentId: String(values.componentId ?? ""),
											unitCostYuan:
												String(values.unitCostYuan ?? "") || undefined,
											content: String(values.content ?? ""),
										},
									});
								}}
								onFinishFailed={showError}
							/>
						</CardContent>
						<CardContent
							className={`grid ${row.sku.endsWith("_PH") ? "grid-cols-3" : "grid-cols-5"} gap-2 text-center`}
						>
							<Metric
								label={m.redeem_warehouse_available()}
								value={row.available}
							/>
							{row.sku.endsWith("_PH") && (
								<Metric
									label={m.redeem_warehouse_assigned()}
									value={row.assigned}
								/>
							)}
							<Metric label={m.redeem_warehouse_leased()} value={row.leased} />
							<Metric
								label={m.redeem_warehouse_processing()}
								value={row.processing}
							/>
							<Metric
								label={m.redeem_warehouse_consumed()}
								value={row.consumed}
							/>
							<Metric
								label={m.redeem_warehouse_quarantined()}
								value={row.quarantined}
							/>
						</CardContent>
					</Card>
				))}
			</div>
		</div>
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
