import { createFileRoute } from "@tanstack/react-router";
import { InvoicePage } from "#/features/invoice/page";
import { utilityPageHead } from "#/lib/seo";
import { m } from "#/paraglide/messages";
export const Route = createFileRoute("/(public)/invoice")({
	head: ({ matches }) => utilityPageHead({ title: m.invoice_title(), matches }),
	component: InvoicePage,
});
