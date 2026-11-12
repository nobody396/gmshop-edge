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
		/** Search snippet; the short description stays on the guide index. */
		seoDescription:
			"买到的 Apple ID 怎么登录 App Store：旧版界面在 App Store 里退出再登录，新版界面从「设置 → 媒体与购买项目」换号，全程不动你自己的 iCloud。附密保问题、双重认证提示怎么选，以及登录失败、搜不到 App、换回自己账号的处理方法。",
		/** Last content change (sitemap lastmod). */
		updatedAt: Date.parse("2026-11-12T15:00:00Z"),
	},
	{
		slug: "appstore-prices",
		path: "/guides/appstore-prices",
		title: "各区 App Store 开会员价格对比：ChatGPT、Claude、Gemini",
		description:
			"美区、日区、菲区、土区 App Store 里 ChatGPT、Claude、Google AI 会员价，换算成人民币，每天更新。",
		seoDescription:
			"美区、日区、菲区、土区 App Store 里 ChatGPT、Claude、Google AI 会员价，换算成人民币，每天更新。",
		// The daily price snapshot moves this forward; see listIndexedStaticPages.
		updatedAt: Date.parse("2026-11-11T12:56:19Z"),
	},
	{
		slug: "claude-network-check",
		path: "/guides/claude-network-check",
		title: "Claude 网络自查指南：地区、IP、客户端与评分",
		description:
			"从能观察到的事实出发，理解一个分数背后有什么、没有什么，以及购买前应该怎么检查。",
		seoDescription:
			"Claude 网络自查指南：讲清地区资格不只看所在国家，住宅宽带、机房和代理线路有什么区别，风险评分怎么扣分、查询数据有哪些时效和误差，WebRTC 与分流怎么判断，以及 macOS、Windows 本机只读排查方法和购买前的检查清单。",
		updatedAt: Date.parse("2026-11-12T15:00:00Z"),
	},
] as const;

export type StaticGuideSlug = (typeof staticGuidePages)[number]["slug"];

export function staticGuidePage(slug: StaticGuideSlug) {
	const page = staticGuidePages.find((entry) => entry.slug === slug);
	if (!page) throw new Error(`Unknown static guide: ${slug}`);
	return page;
}

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
