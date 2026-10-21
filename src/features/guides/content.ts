import { z } from "zod";

/**
 * Client-safe guide constants shared by the public pages and the server.
 * Nothing here may import server-only code; the write rules (banned words,
 * payload schema) live in ./server/rules so they never ship to browsers.
 */

/** Hand-built guide routes; their slugs can never be used by a stored guide. */
export const staticGuidePages = [
	{
		slug: "apple-id-login",
		path: "/guides/apple-id-login",
		title: "Apple ID 登录 App Store 图文教程",
		description: "买到的 Apple ID 怎么登录 App Store：旧版和新版系统两种方法。",
	},
	{
		slug: "claude-network-check",
		path: "/guides/claude-network-check",
		title: "Claude 网络自查指南：地区、IP、客户端与评分",
		description:
			"从能观察到的事实出发，理解一个分数背后有什么、没有什么，以及购买前应该怎么检查。",
	},
] as const;

export const reservedGuideSlugs: ReadonlySet<string> = new Set(
	staticGuidePages.map((page) => page.slug),
);

export const guideSlugSchema = z
	.string()
	.min(2)
	.max(80)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase a-z0-9-");

const BEIJING_OFFSET_MS = 8 * 3_600_000;

/** YYYY-MM-DD in Beijing time, independent of the server or browser zone. */
export function beijingDate(timestampMs: number) {
	return new Date(timestampMs + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}
