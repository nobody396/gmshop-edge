import { createFileRoute } from "@tanstack/react-router";
import { StorefrontOrderPage } from "#/features/storefront/pages/order";

export const Route = createFileRoute("/(public)/orders/$orderNumber")({
	validateSearch: (search: Record<string, unknown>): { payment?: "return" } =>
		search.payment === "return" ? { payment: "return" } : {},
	component: OrderRoute,
});

function OrderRoute() {
	const { orderNumber } = Route.useParams();
	const { payment } = Route.useSearch();
	return (
		<StorefrontOrderPage
			orderNumber={orderNumber}
			paymentReturning={payment === "return"}
		/>
	);
}
