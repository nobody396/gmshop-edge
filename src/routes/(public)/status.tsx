import { createFileRoute } from "@tanstack/react-router";
import { StatusPage } from "#/features/status/pages/status";
import { getStatusFn } from "#/features/status/server/functions";
import { utilityPageHead } from "#/lib/seo";

export const Route = createFileRoute("/(public)/status")({
	loader: () => getStatusFn(),
	head: () => utilityPageHead(),
	component: StatusRoute,
});

function StatusRoute() {
	return <StatusPage report={Route.useLoaderData()} />;
}
