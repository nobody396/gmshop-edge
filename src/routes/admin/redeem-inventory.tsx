import { createFileRoute } from "@tanstack/react-router";
import { RedeemWarehouseAdminPage } from "#/features/redeem-warehouse/pages/admin";

export const Route = createFileRoute("/admin/redeem-inventory")({
	component: RedeemWarehouseAdminPage,
});
