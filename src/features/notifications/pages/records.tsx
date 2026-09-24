"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { ProButton } from "#/components/pro/base/button";
import { ProTable } from "#/components/pro/table";
import { StatusBadge } from "#/components/status-badge";
import { Badge } from "#/components/ui/badge";
import {
	notificationDeliveryErrorLabel,
	notificationEventLabel,
} from "#/features/notifications/labels";
import {
	getNotificationCenterFn,
	retryNotificationDeliveryFn,
} from "#/features/notifications/server/admin";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { m } from "#/paraglide/messages";
import { showNotificationError } from "./error";

type NotificationDelivery = Awaited<
	ReturnType<typeof getNotificationCenterFn>
>["deliveries"][number];

export function EmailRecordsPage() {
	const client = useQueryClient();
	const query = useQuery({
		queryKey: ["admin", "notifications"],
		queryFn: () => getNotificationCenterFn(),
	});
	const retryDelivery = useMutation({
		mutationFn: retryNotificationDeliveryFn,
		onSuccess: async () => {
			await client.invalidateQueries({ queryKey: ["admin", "notifications"] });
			toast.success(m.notifications_retry_queued());
		},
		onError: showNotificationError,
	});
	const columns: ColumnDef<NotificationDelivery>[] = [
		{
			accessorKey: "event",
			header: m.notifications_event(),
			cell: ({ row }) => (
				<strong>{notificationEventLabel(row.original.event)}</strong>
			),
		},
		{
			accessorKey: "channel",
			header: m.notifications_channel(),
			cell: ({ row }) =>
				row.original.channel === "email"
					? m.common_email()
					: row.original.channel,
		},
		{
			accessorKey: "status",
			header: m.common_status(),
			cell: ({ row }) =>
				row.original.status === "delivered" ? (
					<Badge>{m.notifications_status_delivered()}</Badge>
				) : (
					<StatusBadge value={row.original.status} />
				),
		},
		{
			accessorKey: "acceptedAt",
			header: m.notifications_accepted_at(),
			cell: ({ row }) =>
				row.original.acceptedAt == null
					? "—"
					: formatDateTime(row.original.acceptedAt),
		},
		{
			accessorKey: "deliveredAt",
			header: m.notifications_delivered_at(),
			cell: ({ row }) =>
				row.original.deliveredAt == null
					? "—"
					: formatDateTime(row.original.deliveredAt),
		},
		{ accessorKey: "attemptCount", header: m.notifications_attempts() },
		{
			accessorKey: "createdAt",
			header: m.common_created(),
			cell: ({ row }) => formatDateTime(row.original.createdAt),
		},
		{
			accessorKey: "errorCode",
			header: m.common_last_error(),
			cell: ({ row }) => (
				<span title={row.original.errorCode ?? undefined}>
					{notificationDeliveryErrorLabel(row.original.errorCode)}
				</span>
			),
		},
		{
			id: "actions",
			header: m.common_actions(),
			meta: { align: "right" },
			cell: ({ row }) => {
				const retryable =
					row.original.status === "failed" || row.original.manualResendAllowed;
				if (!retryable) return null;
				return (
					<div className="flex justify-end">
						<ProButton
							disabled={retryDelivery.isPending}
							onClick={() =>
								retryDelivery.mutate({ data: { id: row.original.id } })
							}
							size="sm"
							variant="outline"
						>
							<RotateCcw />
							{row.original.manualResendAllowed
								? m.notifications_resend()
								: m.common_retry()}
						</ProButton>
					</div>
				);
			},
		},
	];

	return (
		<div className="flex min-h-0 w-full flex-1 flex-col gap-4">
			<PageHeader
				description={m.notifications_records_description()}
				title={m.notifications_deliveries()}
			/>
			<ProTable
				className="min-h-80"
				columns={columns}
				data={query.data?.deliveries ?? []}
				loading={query.isPending}
				onRefresh={() => query.refetch()}
				pagination={false}
				table={{ stickyHeader: true }}
			/>
		</div>
	);
}
