"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Save } from "lucide-react";
import { toast } from "sonner";
import { Switch as ProSwitch } from "#/components/pro/base/fields/checkbox";
import {
	formBooleanValue,
	ModalForm,
	ProSchemaForm,
} from "#/components/pro/form";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { PageHeader } from "#/layouts/components/page-header";
import { formatMinorAmount } from "#/lib/format";
import { m } from "#/paraglide/messages";
import {
	getSupplierApiConfigurationFn,
	listSupplierExportListingsFn,
	setSupplierApiConfigurationFn,
	setSupplierExportListingFn,
} from "../server/admin";

const configurationKey = ["admin", "supplier-api", "configuration"] as const;
const listingKey = ["admin", "supplier-api", "export-listings"] as const;

export function SupplierApiAdminPage() {
	const formId = "system-settings-supplier-api";
	const client = useQueryClient();
	const configuration = useQuery({
		queryKey: configurationKey,
		queryFn: () => getSupplierApiConfigurationFn(),
	});
	const listings = useQuery({
		queryKey: listingKey,
		queryFn: () => listSupplierExportListingsFn(),
	});
	const toggle = useMutation({
		mutationFn: (enabled: boolean) =>
			setSupplierApiConfigurationFn({ data: { enabled } }),
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: configurationKey });
			toast.success(m.settings_saved());
		},
		onError: () => toast.error(m.web_support_failed()),
	});
	const saveListing = useMutation({
		mutationFn: setSupplierExportListingFn,
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: listingKey });
			toast.success(m.settings_saved());
		},
		onError: () => toast.error(m.web_support_failed()),
	});
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PageHeader
				title={m.settings_supplier_api_enabled()}
				description={m.settings_supplier_api_enabled_description()}
				actions={
					<>
						<Button asChild variant="outline">
							<a href="/openapi" rel="noreferrer" target="_blank">
								<ExternalLink />
								{m.supplier_api_documentation()}
							</a>
						</Button>
						<Button
							disabled={configuration.isLoading || toggle.isPending}
							form={formId}
							type="submit"
						>
							<Save />
							{m.settings_save_changes()}
						</Button>
					</>
				}
			/>
			<div className="mt-6 min-h-0 flex-1 space-y-6 overflow-y-auto pe-3 pb-12">
				<ProSchemaForm
					id={formId}
					key={String(configuration.data?.enabled ?? false)}
					schema={[
						{
							name: "enabled",
							label: m.settings_supplier_api_enabled(),
							description: m.settings_supplier_api_enabled_description(),
							valueType: "switch",
							disabled: configuration.isLoading || toggle.isPending,
						},
					]}
					initialValues={{ enabled: configuration.data?.enabled ?? false }}
					onFinish={async (values) => {
						await toggle.mutateAsync(formBooleanValue(values.enabled));
					}}
					submitter={false}
				/>
				<Card>
					<CardHeader>
						<CardTitle>{m.supplier_api_export_title()}</CardTitle>
						<CardDescription>
							{m.supplier_api_export_description()}
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-3">
						{(listings.data ?? []).map((listing) => (
							<div
								className="flex flex-wrap items-center gap-3 rounded-md border p-3"
								key={listing.sellableItemId}
							>
								<ProSwitch
									aria-label={`${listing.productName} · ${listing.itemName}`}
									disabled={saveListing.isPending}
									onChange={(enabled) =>
										saveListing.mutate({
											data: {
												sellableItemId: listing.sellableItemId,
												enabled,
												price: listing.exportPrice,
											},
										})
									}
									value={listing.enabled}
								/>
								<div className="min-w-0 flex-1">
									<strong className="block truncate text-sm">
										{listing.productName} · {listing.itemName}
									</strong>
									<span className="text-muted-foreground text-xs">
										{m.supplier_api_export_price()}:{" "}
										{formatMinorAmount(
											listing.exportPriceMinor,
											listing.currency,
											listing.currencyDecimals,
										)}{" "}
										· {m.redeem_warehouse_available()}: {listing.stockQuantity}
									</span>
								</div>
								<ModalForm
									title={m.supplier_api_export_edit()}
									trigger={
										<Button size="sm" variant="outline">
											{m.common_edit()}
										</Button>
									}
									schema={[
										{
											name: "enabled",
											label: m.common_enabled(),
											valueType: "switch",
										},
										{
											name: "price",
											label: m.supplier_api_export_price(),
											valueType: "text",
											required: true,
											fieldProps: { inputMode: "decimal" },
										},
									]}
									initialValues={{
										enabled: listing.enabled,
										price: listing.exportPrice,
									}}
									onFinish={async (values) => {
										await saveListing.mutateAsync({
											data: {
												sellableItemId: listing.sellableItemId,
												enabled: formBooleanValue(values.enabled),
												price: String(values.price ?? ""),
											},
										});
									}}
									onFinishFailed={() => toast.error(m.web_support_failed())}
								/>
							</div>
						))}
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
