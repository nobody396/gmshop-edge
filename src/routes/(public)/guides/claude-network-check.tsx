import { createFileRoute } from "@tanstack/react-router";
import { IpCheckGuide } from "#/features/ip-check/guide";
import { createArticleSeoHead } from "#/lib/seo";
import { m } from "#/paraglide/messages";
export const Route = createFileRoute("/(public)/guides/claude-network-check")({
	component: IpCheckGuide,
	head: ({ matches }) =>
		createArticleSeoHead(matches, {
			title: m.ip_article_title(),
			description: m.ip_article_intro(),
			path: "/guides/claude-network-check",
		}),
});
