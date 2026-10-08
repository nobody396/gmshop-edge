"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { formBooleanValue, ModalForm } from "#/components/pro/form";
import { ProTable, type ProTableState } from "#/components/pro/table";
import { Badge } from "#/components/ui/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { Switch } from "#/components/ui/switch";
import {
	catalogOptionsQuery,
	catalogOptionsQueryKey,
} from "#/features/catalog/queries";
import { couponOperationErrorMessage } from "#/features/coupons/error-message";
import { couponTypes } from "#/features/coupons/schema";
import {
	deleteCouponFn,
	listCouponsFn,
	saveCouponFn,
	setCouponEnabledFn,
} from "#/features/coupons/server/admin";
import { PromotionAdmin } from "#/features/promotions/admin";
import { ConfirmDialog } from "#/layouts/components/confirm-dialog";
import { PageHeader } from "#/layouts/components/page-header";
import {
	formatBasisPoints,
	formatDateTime,
	formatMinorAmount,
	formatNumber,
} from "#/lib/format";
import { useCurrentProTableUrlState } from "#/lib/pro-table-url-state";
import { m } from "#/paraglide/messages";

type CouponPageResult = Awaited<ReturnType<typeof listCouponsFn>>;
type Coupon = CouponPageResult["data"][number];

export function CouponsPage() {
	const tableUrlState = useCurrentProTableUrlState({ searchColumnId: "code" });
	const client = useQueryClient();
	const options = useQuery(catalogOptionsQuery);
	const [refreshKey, setRefreshKey] = useState(0);
	const [editing, setEditing] = useState<Coupon | null>(null);
	const [deleting, setDeleting] = useState<Coupon | null>(null);
	const refresh = useCallback(async () => {
		await Promise.all([
			client.invalidateQueries({ queryKey: ["admin", "coupons"] }),
			client.invalidateQueries({ queryKey: catalogOptionsQueryKey }),
		]);
		setRefreshKey((value) => value + 1);
	}, [client]);
	const request = useCallback(
		(state: ProTableState) => {
			const search = String(
				state.columnFilters.find((filter) => filter.id === "code")?.value ?? "",
			);
			const input = {
				pageIndex: state.pagination.pageIndex,
				pageSize: state.pagination.pageSize,
				search,
			};
			return client.fetchQuery({
				queryKey: ["admin", "coupons", input],
				queryFn: () => listCouponsFn({ data: input }),
			});
		},
		[client],
	);
	const save = useMutation({
		mutationFn: saveCouponFn,
		onSuccess: async () => {
			setEditing(null);
			await refresh();
		},
		onError: showError,
	});
	const toggle = useMutation({
		mutationFn: setCouponEnabledFn,
		onSuccess: refresh,
		onError: showError,
	});
	const remove = useMutation({
		mutationFn: deleteCouponFn,
		onSuccess: async () => {
			setDeleting(null);
			await refresh();
		},
		onError: showError,
	});
	const columns = useMemo<ColumnDef<Coupon>[]>(
		() => [
			{
				accessorKey: "enabled",
				header: m.common_enabled(),
				cell: ({ row }) => (
					<Switch
						aria-label={`${m.common_enabled()} · ${row.original.code}`}
						checked={row.original.enabled}
						disabled={toggle.isPending}
						onCheckedChange={(enabled) =>
							toggle.mutate({ data: { id: row.original.id, enabled } })
						}
					/>
				),
			},
			{
				accessorKey: "code",
				header: m.coupons_coupon(),
				meta: { search: true },
				cell: ({ row }) => (
					<div>
						<strong className="block font-mono">{row.original.code}</strong>
						<span className="text-muted-foreground text-xs">
							{row.original.purpose === "standard"
								? row.original.name
								: row.original.purpose === "referral"
									? m.promotion_type_referral()
									: m.promotion_type_recall()}
						</span>
					</div>
				),
			},
			{
				accessorKey: "type",
				header: m.common_type(),
				cell: ({ row }) => (
					<Badge variant="outline">
						{row.original.purpose === "standard"
							? couponTypeLabel(row.original.type)
							: row.original.purpose === "referral"
								? m.promotion_type_referral()
								: m.promotion_type_recall()}
					</Badge>
				),
			},
			{
				id: "value",
				header: m.coupons_value(),
				cell: ({ row }) => couponValue(row.original),
			},
			{
				accessorKey: "usedCount",
				header: m.coupons_usage(),
				cell: ({ row }) =>
					`${formatNumber(row.original.usedCount)} / ${row.original.usageLimit == null ? "∞" : formatNumber(row.original.usageLimit)}`,
			},
			{
				id: "scope",
				header: m.coupons_scope(),
				cell: ({ row }) =>
					row.original.purpose !== "standard"
						? m.promotion_eligible_items()
						: row.original.productIds.length || row.original.tagNames.length
							? m.coupons_scope_count({
									products: row.original.productIds.length,
									tags: row.original.tagNames.length,
								})
							: m.coupons_scope_all(),
			},
			{
				id: "validity",
				header: m.coupons_validity(),
				cell: ({ row }) => (
					<div className="grid text-xs">
						<span>
							{row.original.startsAt
								? formatDateTime(row.original.startsAt)
								: m.coupons_no_start()}
						</span>
						<span>
							{row.original.endsAt
								? formatDateTime(row.original.endsAt)
								: m.coupons_no_end()}
						</span>
					</div>
				),
			},
			{
				id: "actions",
				header: m.common_actions(),
				cell: ({ row }) => (
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
									disabled={row.original.purpose !== "standard"}
									onClick={() => setEditing(row.original)}
								>
									<Pencil />
									{m.common_edit()}
								</DropdownMenuItem>
								<DropdownMenuItem
									variant="destructive"
									disabled={
										row.original.purpose !== "standard" ||
										row.original.usedCount > 0
									}
									onClick={() => setDeleting(row.original)}
								>
									<Trash2 />
									{m.common_delete()}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				),
			},
		],
		[toggle],
	);
	const tags = options.data?.tags ?? [];
	const products = options.data?.products ?? [];

	async function submit(values: Record<string, unknown>, coupon?: Coupon) {
		await save.mutateAsync({
			data: {
				id: coupon?.id,
				code: String(values.code ?? ""),
				name: String(values.name ?? ""),
				type: String(values.type ?? "fixed") as (typeof couponTypes)[number],
				currency: String(values.currency ?? ""),
				currencyDecimals: optionalNumber(values.currencyDecimals),
				valueMinor: String(values.valueMinor ?? ""),
				valueBps: optionalNumber(values.valueBps),
				minimumOrderMinor: String(values.minimumOrderMinor ?? ""),
				maximumDiscountMinor: String(values.maximumDiscountMinor ?? ""),
				usageLimit: optionalNumber(values.usageLimit),
				usageLimitPerCustomer: optionalNumber(values.usageLimitPerCustomer),
				startsAt: dateValue(values.startsAt),
				endsAt: dateValue(values.endsAt),
				enabled: formBooleanValue(values.enabled),
				productIds: stringArray(values.productIds),
				tagNames: stringArray(values.tagNames),
			},
		});
	}

	return (
		<>
			<PromotionAdmin onIssued={refresh} />
			<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
				<PageHeader
					title={m.nav_coupons()}
					description={m.coupons_description()}
					actions={
						<ModalForm
							title={m.coupons_new()}
							trigger={<ProButton>{m.common_new()}</ProButton>}
							schema={couponFormSchema(tags, products)}
							initialValues={newCouponValues}
							onFinish={(values) => submit(values)}
							onFinishFailed={showError}
							modalClassName="sm:max-w-3xl"
						/>
					}
				/>
				<ProTable
					initialState={tableUrlState.initialState}
					onChange={tableUrlState.onChange}
					className="min-h-0 flex-1"
					columns={columns}
					request={request}
					requestKey={refreshKey}
					onRefresh={refresh}
					toolbarSearch={{ columnId: "code", placeholder: m.common_search() }}
					table={{ stickyHeader: true }}
				/>
			</div>
			{editing ? (
				<ModalForm
					key={editing.id}
					open
					onOpenChange={(open) => !open && setEditing(null)}
					title={m.coupons_edit()}
					schema={couponFormSchema(tags, products)}
					initialValues={couponValues(editing)}
					onFinish={(values) => submit(values, editing)}
					onFinishFailed={showError}
					modalClassName="sm:max-w-3xl"
				/>
			) : null}
			<ConfirmDialog
				open={Boolean(deleting)}
				onOpenChange={(open) => !open && setDeleting(null)}
				title={m.coupons_delete_title()}
				desc={m.coupons_delete_description({ code: deleting?.code ?? "" })}
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

function couponFormSchema(
	tags: Array<{ name: string }>,
	products: Array<{ id: string; name: string }>,
) {
	return [
		{ name: "code", label: m.coupons_code(), required: true },
		{ name: "name", label: m.common_name(), required: true },
		{
			name: "type",
			label: m.common_type(),
			valueType: "select" as const,
			required: true,
			fieldProps: {
				options: couponTypes.map((value) => ({
					value,
					label: couponTypeLabel(value),
				})),
			},
		},
		{ name: "currency", label: m.common_currency() },
		{
			name: "currencyDecimals",
			label: m.catalog_currency_decimals(),
			fieldProps: { inputMode: "numeric" },
		},
		{
			name: "valueMinor",
			label: m.coupons_fixed_value_minor(),
			fieldProps: { inputMode: "numeric" },
		},
		{
			name: "valueBps",
			label: m.coupons_percentage_bps(),
			fieldProps: { inputMode: "numeric" },
		},
		{
			name: "minimumOrderMinor",
			label: m.coupons_minimum_order_minor(),
			fieldProps: { inputMode: "numeric" },
		},
		{
			name: "maximumDiscountMinor",
			label: m.coupons_maximum_discount_minor(),
			fieldProps: { inputMode: "numeric" },
		},
		{
			name: "usageLimit",
			label: m.coupons_usage_limit(),
			fieldProps: { inputMode: "numeric" },
		},
		{
			name: "usageLimitPerCustomer",
			label: m.coupons_customer_limit(),
			fieldProps: { inputMode: "numeric" },
		},
		{
			name: "startsAt",
			label: m.coupons_starts_at(),
			valueType: "dateTime" as const,
		},
		{
			name: "endsAt",
			label: m.coupons_ends_at(),
			valueType: "dateTime" as const,
		},
		{
			name: "tagNames",
			label: m.coupons_tags(),
			valueType: "multiSelect" as const,
			fieldProps: {
				options: tags.map((item) => ({
					value: item.name,
					label: item.name,
				})),
				searchable: true,
			},
		},
		{
			name: "productIds",
			label: m.coupons_products(),
			valueType: "multiSelect" as const,
			fieldProps: {
				options: products.map((item) => ({ value: item.id, label: item.name })),
				searchable: true,
			},
		},
		{
			name: "enabled",
			label: m.common_enabled(),
			valueType: "switch" as const,
		},
	];
}

const newCouponValues = {
	type: "fixed",
	currency: "USD",
	currencyDecimals: "2",
	enabled: true,
	productIds: [],
	tagNames: [],
};

function couponValues(coupon: Coupon) {
	return {
		code: coupon.code,
		name: coupon.name,
		type: coupon.type,
		currency: coupon.currency ?? "",
		currencyDecimals:
			coupon.currencyDecimals == null ? "" : String(coupon.currencyDecimals),
		valueMinor: coupon.valueMinor ?? "",
		valueBps: coupon.valueBps == null ? "" : String(coupon.valueBps),
		minimumOrderMinor: coupon.minimumOrderMinor ?? "",
		maximumDiscountMinor: coupon.maximumDiscountMinor ?? "",
		usageLimit: coupon.usageLimit == null ? "" : String(coupon.usageLimit),
		usageLimitPerCustomer:
			coupon.usageLimitPerCustomer == null
				? ""
				: String(coupon.usageLimitPerCustomer),
		startsAt: coupon.startsAt ? new Date(coupon.startsAt) : undefined,
		endsAt: coupon.endsAt ? new Date(coupon.endsAt) : undefined,
		enabled: coupon.enabled,
		productIds: coupon.productIds,
		tagNames: coupon.tagNames,
	};
}

function couponValue(coupon: Coupon) {
	if (coupon.purpose !== "standard") return m.promotion_dynamic_budget();
	if (coupon.type === "percentage")
		return formatBasisPoints(coupon.valueBps ?? 0);
	if (!coupon.currency || coupon.currencyDecimals == null || !coupon.valueMinor)
		return "—";
	return formatMinorAmount(
		coupon.valueMinor,
		coupon.currency,
		coupon.currencyDecimals,
	);
}

function couponTypeLabel(type: string) {
	return type === "fixed"
		? m.coupons_type_fixed()
		: m.coupons_type_percentage();
}

function optionalNumber(value: unknown) {
	const text = String(value ?? "").trim();
	return text ? Number(text) : null;
}

function dateValue(value: unknown) {
	if (value instanceof Date) return value.getTime();
	const text = String(value ?? "").trim();
	return text ? new Date(text).getTime() : null;
}

function stringArray(value: unknown) {
	if (Array.isArray(value)) return value.map(String);
	return value == null || value === "" ? [] : [String(value)];
}

function showError(error: unknown) {
	toast.error(couponOperationErrorMessage(error));
}
