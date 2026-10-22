import { createFileRoute } from "@tanstack/react-router";
import { CustomerPricingPage } from "#/features/customer-pricing/pages/admin";

export const Route = createFileRoute("/admin/pricing")({
	component: CustomerPricingPage,
});
