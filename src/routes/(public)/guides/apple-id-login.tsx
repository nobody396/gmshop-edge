import { createFileRoute } from "@tanstack/react-router";
import {
	AppleIdLoginGuide,
	appleIdLoginGuidePath,
} from "#/features/guides/apple-id-login";
import { createArticleSeoHead } from "#/lib/seo";

export const Route = createFileRoute("/(public)/guides/apple-id-login")({
	component: AppleIdLoginGuide,
	head: ({ matches }) =>
		createArticleSeoHead(matches, {
			title: "Apple ID 登录 App Store 图文教程",
			description:
				"买到的 Apple ID 怎么登录 App Store：旧版和新版系统两种方法。",
			path: appleIdLoginGuidePath,
		}),
});
