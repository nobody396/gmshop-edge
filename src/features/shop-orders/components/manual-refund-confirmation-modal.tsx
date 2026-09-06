"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { formBooleanValue, ModalForm } from "#/components/pro/form";
import { completeManualShopRefundFn } from "#/features/shop-orders/server/admin";
import { m } from "#/paraglide/messages";

export function ManualRefundConfirmationModal({
	refundId,
	onOpenChange,
	onCompleted,
}: {
	refundId: string | null;
	onOpenChange: (open: boolean) => void;
	onCompleted: () => void | Promise<void>;
}) {
	const complete = useMutation({
		mutationFn: completeManualShopRefundFn,
		onSuccess: async () => {
			onOpenChange(false);
			await onCompleted();
			toast.success(m.shop_orders_manual_refund_completed());
		},
		onError: () => toast.error(m.shop_orders_operation_failed()),
	});
	if (!refundId) return null;
	return (
		<ModalForm
			key={refundId}
			open
			onOpenChange={onOpenChange}
			title={m.shop_orders_manual_refund_confirm()}
			description={m.shop_orders_manual_refund_description()}
			schema={[
				{
					name: "reference",
					label: m.shop_orders_manual_refund_reference(),
					required: true,
				},
				{
					name: "fundsReturned",
					label: m.shop_orders_manual_refund_funds_returned(),
					valueType: "switch" as const,
					description: m.shop_orders_manual_refund_funds_returned_description(),
					initialValue: false,
				},
			]}
			onFinish={async (values) => {
				if (!formBooleanValue(values.fundsReturned)) {
					toast.error(m.shop_orders_manual_refund_funds_not_returned());
					return;
				}
				await complete.mutateAsync({
					data: {
						id: refundId,
						reference: String(values.reference ?? ""),
						fundsReturned: true,
					},
				});
			}}
			onFinishFailed={() => toast.error(m.shop_orders_operation_failed())}
		/>
	);
}
