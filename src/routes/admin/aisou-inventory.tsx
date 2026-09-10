import { createFileRoute } from "@tanstack/react-router";
import { AisouInventoryAdminPage } from "#/features/aisou-inventory/pages/admin";

export const Route = createFileRoute("/admin/aisou-inventory")({
	component: AisouInventoryAdminPage,
});
