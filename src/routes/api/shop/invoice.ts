import { createFileRoute } from "@tanstack/react-router";
import { invoiceRequest } from "#/features/invoice/server";
export const Route = createFileRoute("/api/shop/invoice")({
	server: { handlers: { POST: ({ request }) => invoiceRequest(request) } },
});
