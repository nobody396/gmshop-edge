import { createFileRoute, redirect } from "@tanstack/react-router";
import { StorefrontOrderPage } from "#/features/storefront/pages/order";
import { getAccountOrderFn } from "#/features/storefront/server/account-functions";

export const Route = createFileRoute("/(public)/account/orders/$orderNumber")({
	validateSearch: (
		search: Record<string, unknown>,
	): { from?: "entitlements"; payment?: "return" } => ({
		...(search.from === "entitlements"
			? { from: "entitlements" as const }
			: {}),
		...(search.payment === "return" ? { payment: "return" as const } : {}),
	}),
	loader: async ({ params }) => {
		try {
			return await getAccountOrderFn({
				data: { orderNumber: params.orderNumber },
			});
		} catch {
			throw redirect({ to: "/account" });
		}
	},
	component: AccountOrderRoute,
});

function AccountOrderRoute() {
	const { orderNumber } = Route.useParams();
	const { from, payment } = Route.useSearch();
	return (
		<StorefrontOrderPage
			accountOrder={Route.useLoaderData()}
			backToEntitlements={from === "entitlements"}
			orderNumber={orderNumber}
			paymentReturning={payment === "return"}
		/>
	);
}
