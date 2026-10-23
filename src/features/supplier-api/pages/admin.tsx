"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Save, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Switch as ProSwitch } from "#/components/pro/base/fields/checkbox";
import {
	formBooleanValue,
	ModalForm,
	ProSchemaForm,
} from "#/components/pro/form";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { PageHeader } from "#/layouts/components/page-header";
import { formatMinorAmount } from "#/lib/format";
import { m } from "#/paraglide/messages";
import {
	allowSupplierApiUserFn,
	disallowSupplierApiUserFn,
	getSupplierApiConfigurationFn,
	listSupplierApiAllowedUsersFn,
	listSupplierExportListingsFn,
	setSupplierApiConfigurationFn,
	setSupplierExportListingFn,
} from "../server/admin";

const configurationKey = ["admin", "supplier-api", "configuration"] as const;
const listingKey = ["admin", "supplier-api", "export-listings"] as const;
const allowlistKey = ["admin", "supplier-api", "allowed-users"] as const;

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
				<SupplierApiAllowlistCard />
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

function SupplierApiAllowlistCard() {
	const client = useQueryClient();
	const [email, setEmail] = useState("");
	const allowed = useQuery({
		queryKey: allowlistKey,
		queryFn: () => listSupplierApiAllowedUsersFn(),
	});
	const refresh = async () => {
		await client.invalidateQueries({ queryKey: allowlistKey });
		toast.success(m.settings_saved());
	};
	const allow = useMutation({
		mutationFn: (value: string) =>
			allowSupplierApiUserFn({ data: { email: value } }),
		onSuccess: async () => {
			setEmail("");
			await refresh();
		},
		onError: () => toast.error(m.web_support_failed()),
	});
	const remove = useMutation({
		mutationFn: (userId: string) =>
			disallowSupplierApiUserFn({ data: { userId } }),
		onSuccess: refresh,
		onError: () => toast.error(m.web_support_failed()),
	});
	return (
		<Card>
			<CardHeader>
				<CardTitle>{m.supplier_api_allowlist_title()}</CardTitle>
				<CardDescription>
					{m.supplier_api_allowlist_description()}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				<form
					className="flex flex-wrap items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (email.trim()) allow.mutate(email.trim());
					}}
				>
					<Input
						aria-label={m.supplier_api_allowlist_email()}
						autoComplete="off"
						className="min-w-0 flex-1"
						onChange={(event) => setEmail(event.target.value)}
						placeholder={m.supplier_api_allowlist_email()}
						type="email"
						value={email}
					/>
					<Button disabled={allow.isPending || !email.trim()} type="submit">
						<UserPlus />
						{m.supplier_api_allowlist_add()}
					</Button>
				</form>
				{(allowed.data ?? []).length === 0 && !allowed.isLoading ? (
					<p className="text-muted-foreground text-sm">
						{m.supplier_api_allowlist_empty()}
					</p>
				) : null}
				{(allowed.data ?? []).map((entry) => (
					<div
						className="flex flex-wrap items-center gap-3 rounded-md border p-3"
						key={entry.userId}
					>
						<div className="min-w-0 flex-1">
							<strong className="block truncate text-sm">{entry.email}</strong>
							<span className="text-muted-foreground text-xs">
								{m.supplier_api_allowlist_active_keys({
									count: entry.activeKeys,
								})}
							</span>
						</div>
						<AlertDialog>
							<AlertDialogTrigger asChild>
								<Button disabled={remove.isPending} size="sm" variant="outline">
									{m.supplier_api_allowlist_remove()}
								</Button>
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>
										{m.supplier_api_allowlist_remove()} · {entry.email}
									</AlertDialogTitle>
									<AlertDialogDescription>
										{m.supplier_api_allowlist_description()}
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>{m.common_cancel()}</AlertDialogCancel>
									<AlertDialogAction
										onClick={() => remove.mutate(entry.userId)}
									>
										{m.common_confirm()}
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
