"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ChevronDown,
	PackagePlus,
	RefreshCw,
	Settings,
	Zap,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ModalForm } from "#/components/pro/form";
import { Badge } from "#/components/ui/badge";
import { Card, CardContent } from "#/components/ui/card";
import {
	generateRedeemSellableInventoryFn,
	getRedeemWarehouseConfigurationFn,
	saveRedeemWarehouseConfigurationFn,
} from "#/features/redeem-warehouse/server/admin";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime, formatMinorAmountWithSymbol } from "#/lib/format";
import { m } from "#/paraglide/messages";
import { listSupplyConsoleFn } from "../server/query";
import { restockSupplyFn } from "../server/restock";

const consoleKey = ["admin", "supply-console"] as const;

type Row = Awaited<ReturnType<typeof listSupplyConsoleFn>>[number];

export function SupplyConsolePage() {
	const client = useQueryClient();
	const [expanded, setExpanded] = useState<string | null>(null);
	const supply = useQuery({
		queryKey: consoleKey,
		queryFn: () => listSupplyConsoleFn(),
	});
	const configuration = useQuery({
		queryKey: ["admin", "supply-console", "configuration"] as const,
		queryFn: () => getRedeemWarehouseConfigurationFn(),
	});
	const saveConfiguration = useMutation({
		mutationFn: saveRedeemWarehouseConfigurationFn,
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: consoleKey });
			toast.success(m.redeem_warehouse_configuration_saved());
		},
		onError: () => toast.error(m.web_support_failed()),
	});
	const generate = useMutation({
		mutationFn: generateRedeemSellableInventoryFn,
		onSuccess: async (result) => {
			await client.invalidateQueries({ queryKey: consoleKey });
			toast.success(
				m.redeem_warehouse_sellable_result({
					count: result.count,
					imported: result.imported,
				}),
			);
		},
		onError: () => toast.error(m.web_support_failed()),
	});
	const restock = useMutation({
		mutationFn: restockSupplyFn,
		onSuccess: async (result) => {
			await client.invalidateQueries({ queryKey: consoleKey });
			if (result.generationFailed)
				toast.warning(
					m.supply_console_restock_partial({ imported: result.imported }),
				);
			else if (result.imported === 0)
				toast.warning(m.supply_console_restock_none({ total: result.total }));
			else
				toast.success(
					m.supply_console_restock_done({
						total: result.total,
						imported: result.imported,
					}),
				);
		},
		onError: () => toast.error(m.web_support_failed()),
	});
	const rows = supply.data ?? [];

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain pb-6">
			<PageHeader
				title={m.supply_console_title()}
				description={m.supply_console_description()}
				actions={
					<>
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
							onFinishFailed={() => toast.error(m.web_support_failed())}
						/>
						<ProButton
							variant="outline"
							disabled={supply.isFetching}
							onClick={() => supply.refetch()}
						>
							<RefreshCw />
							{m.common_refresh()}
						</ProButton>
					</>
				}
			/>
			<Card>
				<CardContent className="p-0">
					<div className="grid grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto] items-center gap-2 border-b px-4 py-2 text-muted-foreground text-xs">
						<span>{m.supply_console_column_sku()}</span>
						<span className="text-right">
							{m.supply_console_column_price()}
						</span>
						<span className="text-right">
							{m.supply_console_column_supply_price()}
						</span>
						<span className="text-right">
							{m.supply_console_column_available()}
						</span>
						<span className="text-right">
							{m.supply_console_column_deliverable()}
						</span>
						<span className="w-24" />
					</div>
					{rows.map((row) => (
						<SupplyRow
							key={row.componentId}
							row={row}
							expanded={expanded === row.componentId}
							onToggle={() =>
								setExpanded(
									expanded === row.componentId ? null : row.componentId,
								)
							}
							onGenerate={(count) =>
								generate.mutateAsync({
									data: {
										requestRef: `supply_gen_${crypto.randomUUID()}`,
										sku: row.centralSku ?? "",
										componentId: row.componentId,
										count,
									},
								})
							}
							onRestock={(values) =>
								restock.mutateAsync({
									data: {
										requestRef: `supply_${crypto.randomUUID()}`,
										componentId: row.componentId,
										unitCostYuan: values.unitCostYuan,
										content: values.content,
										...(values.usageUrl ? { usageUrl: values.usageUrl } : {}),
									},
								})
							}
						/>
					))}
				</CardContent>
			</Card>
		</div>
	);
}

function SupplyRow({
	row,
	expanded,
	onToggle,
	onGenerate,
	onRestock,
}: {
	row: Row;
	expanded: boolean;
	onToggle: () => void;
	onGenerate: (count: number) => Promise<unknown>;
	onRestock: (values: {
		unitCostYuan: string;
		content: string;
		usageUrl?: string;
	}) => Promise<unknown>;
}) {
	const direct = row.centralSku === null;
	return (
		<div className="border-b last:border-b-0">
			<div className="grid grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))_auto] items-center gap-2 px-4 py-3 text-sm">
				<button
					type="button"
					onClick={onToggle}
					className="flex min-w-0 items-center gap-2 text-left"
				>
					<ChevronDown
						className={`size-4 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
					/>
					<span className="min-w-0">
						<span className="block truncate">{row.itemName}</span>
						<span className="block truncate text-muted-foreground text-xs">
							{row.productName}
						</span>
					</span>
				</button>
				<span className="text-right tabular-nums">
					{money(row.usdtMinor)} / {money(row.alipayMinor)}
				</span>
				<span className="text-right tabular-nums">
					{money(row.supplyMinor)}
				</span>
				<span className="text-right tabular-nums">{row.available}</span>
				<span className="text-right tabular-nums">
					{row.deliverable}
					{row.gap > 0 ? (
						<Badge variant="destructive" className="ml-2">
							{m.supply_console_gap({ count: row.gap })}
						</Badge>
					) : null}
				</span>
				<ModalForm
					title={`${m.supply_console_restock()} · ${row.itemName}`}
					description={
						direct
							? m.supply_console_restock_direct_hint()
							: m.supply_console_restock_central_hint({
									sku: row.centralSku ?? "",
								})
					}
					trigger={
						<ProButton size="sm" disabled={row.mode !== "local"}>
							<Zap />
							{m.supply_console_restock()}
						</ProButton>
					}
					schema={[
						{
							name: "unitCostYuan",
							label: m.supply_console_unit_cost(),
							valueType: "text",
							required: true,
							fieldProps: { inputMode: "decimal", placeholder: "660.00" },
						},
						{
							name: "content",
							label: m.supply_console_keys(),
							valueType: "textarea",
							required: true,
							tooltip: m.supply_console_keys_hint(),
							fieldProps: { rows: 8, autoComplete: "off", spellCheck: false },
						},
						...(direct
							? [
									{
										name: "usageUrl" as const,
										label: m.supply_console_usage_url(),
										valueType: "text" as const,
										required: true,
										tooltip: m.supply_console_usage_url_hint(),
									},
								]
							: []),
					]}
					initialValues={{
						unitCostYuan: row.lastUnitCostMinor
							? (Number(row.lastUnitCostMinor) / 100).toFixed(2)
							: "",
					}}
					onFinish={async (values) => {
						await onRestock({
							unitCostYuan: String(values.unitCostYuan ?? ""),
							content: String(values.content ?? ""),
							usageUrl: values.usageUrl ? String(values.usageUrl) : undefined,
						});
					}}
					onFinishFailed={() => toast.error(m.web_support_failed())}
				/>
			</div>
			{expanded ? (
				<div className="grid gap-2 bg-muted/20 px-10 py-3 text-xs sm:grid-cols-2">
					<Detail label={m.supply_console_source()} value={sourceText(row)} />
					<Detail
						label={m.supply_console_cost()}
						value={`${money(row.costMinor)}${
							row.lastUnitCostMinor
								? ` · ${m.supply_console_last_cost({ price: money(row.lastUnitCostMinor) })}`
								: ""
						}`}
					/>
					<Detail
						label={m.supply_console_reserved()}
						value={String(row.reserved)}
					/>
					{row.centralSku ? (
						<ModalForm
							title={m.redeem_warehouse_generate_sellable()}
							description={m.supply_console_generate_hint()}
							trigger={
								<ProButton variant="outline" size="sm" className="w-fit">
									<PackagePlus />
									{m.redeem_warehouse_generate_sellable()}
								</ProButton>
							}
							schema={[
								{
									name: "count",
									label: m.redeem_warehouse_generate_count(),
									valueType: "text",
									required: true,
									fieldProps: { type: "number", min: 1, max: 100 },
								},
							]}
							initialValues={{ count: 1 }}
							onFinish={async (values) => {
								await onGenerate(Number(values.count));
							}}
							onFinishFailed={() => toast.error(m.web_support_failed())}
						/>
					) : null}
					<Detail
						label={m.supply_console_last_restock()}
						value={
							row.lastRestockedAt ? formatDateTime(row.lastRestockedAt) : "—"
						}
					/>
				</div>
			) : null}
		</div>
	);
}

function Detail({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex gap-2">
			<span className="text-muted-foreground">{label}</span>
			<span className="min-w-0 break-words">{value}</span>
		</div>
	);
}

function sourceText(row: Row) {
	if (row.centralSku)
		return m.supply_console_source_central({
			sku: row.centralSku,
			available: row.centralAvailable ?? 0,
		});
	if (row.mode === "supplier" && row.binding)
		return m.supply_console_source_supplier({
			provider: row.binding.provider,
			product: row.binding.product ?? "",
			stock: row.binding.stock,
		});
	if (row.mode === "manual") return m.supply_console_source_manual();
	return m.supply_console_source_direct();
}

function money(minor: string | null) {
	if (minor === null) return "—";
	return formatMinorAmountWithSymbol(minor, "CNY", 2);
}
