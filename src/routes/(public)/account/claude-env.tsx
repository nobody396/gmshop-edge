import { createFileRoute } from "@tanstack/react-router";
import { ClaudeEnvAccountPage } from "#/features/claude-env/pages/account";
import { getOwnClaudeEnvsFn } from "#/features/claude-env/server/functions";

export const Route = createFileRoute("/(public)/account/claude-env")({
	loader: () => getOwnClaudeEnvsFn(),
	head: () => ({
		meta: [
			{ title: "我的 Claude 专属环境" },
			{ name: "robots", content: "noindex, nofollow" },
		],
	}),
	component: ClaudeEnvAccountRoute,
});

function ClaudeEnvAccountRoute() {
	const data = Route.useLoaderData();
	return <ClaudeEnvAccountPage orderNumbers={data.orderNumbers} />;
}
