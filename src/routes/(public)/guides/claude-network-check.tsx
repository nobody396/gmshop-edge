import { createFileRoute } from "@tanstack/react-router";
import { staticGuidePage } from "#/features/guides/content";
import { IpCheckGuide } from "#/features/ip-check/guide";
import { createArticleSeoHead } from "#/lib/seo";
import { m } from "#/paraglide/messages";

const page = staticGuidePage("claude-network-check");
export const Route = createFileRoute("/(public)/guides/claude-network-check")({
	component: IpCheckGuide,
	head: ({ matches }) =>
		createArticleSeoHead(matches, {
			title: m.ip_article_title(),
			description: page.seoDescription,
			path: page.path,
		}),
});
