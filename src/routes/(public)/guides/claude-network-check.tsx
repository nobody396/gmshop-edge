import { createFileRoute } from "@tanstack/react-router";
import { IpCheckGuide } from "#/features/ip-check/guide";
import { m } from "#/paraglide/messages";
export const Route = createFileRoute("/(public)/guides/claude-network-check")({
	component: IpCheckGuide,
	head: () => ({
		meta: [
			{ title: m.ip_article_title() },
			{ name: "description", content: m.ip_article_intro() },
		],
	}),
});
