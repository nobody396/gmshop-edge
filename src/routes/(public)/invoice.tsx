import { createFileRoute } from "@tanstack/react-router";
import { InvoicePage } from "#/features/invoice/page";
export const Route = createFileRoute("/(public)/invoice")({
	component: InvoicePage,
});
