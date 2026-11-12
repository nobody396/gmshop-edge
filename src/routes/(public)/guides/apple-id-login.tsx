import { createFileRoute } from "@tanstack/react-router";
import {
	AppleIdLoginGuide,
	appleIdLoginGuidePath,
} from "#/features/guides/apple-id-login";
import { staticGuidePage } from "#/features/guides/content";
import { createArticleSeoHead } from "#/lib/seo";

const page = staticGuidePage("apple-id-login");

export const Route = createFileRoute("/(public)/guides/apple-id-login")({
	component: AppleIdLoginGuide,
	head: ({ matches }) =>
		createArticleSeoHead(matches, {
			title: page.title,
			description: page.seoDescription,
			path: appleIdLoginGuidePath,
		}),
});
