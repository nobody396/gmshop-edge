import { createFileRoute } from "@tanstack/react-router";
import { ClaudeEnvGuidePage } from "#/features/claude-env/pages/guide";
import { getClaudeEnvGuideFn } from "#/features/claude-env/server/functions";

export const Route = createFileRoute("/(public)/account/claude-env-guide")({
	loader: () => getClaudeEnvGuideFn(),
	head: () => ({
		meta: [
			{ title: "Claude 专属环境完整教程" },
			{ name: "robots", content: "noindex, nofollow" },
		],
	}),
	component: ClaudeEnvGuideRoute,
});

function ClaudeEnvGuideRoute() {
	const data = Route.useLoaderData();
	return <ClaudeEnvGuidePage allowed={data.allowed} guide={data.guide} />;
}
