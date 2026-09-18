import { createFileRoute } from "@tanstack/react-router";
import { SupplyConsolePage } from "#/features/supply-console/pages/admin";

export const Route = createFileRoute("/admin/supply")({
	component: SupplyConsolePage,
});
