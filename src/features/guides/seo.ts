import type { PublicGuideData } from "#/features/guides/queries";
import { createDefaultSeoHead, jsonLdScript } from "#/lib/seo";
import { absoluteSiteUrl } from "#/lib/site-url";

export const guidesIndexTitle = "使用指南";
export const guidesIndexDescription =
	"AI 会员充值、卡密兑换、账号登录与网络自查的图文指南，价格与库存实时同步商城。";
/** Search title and snippet for /guides; the visible heading stays short. */
export const guidesIndexSeoTitle =
	"AI 会员充值与账号使用指南：ChatGPT、Claude、Gemini、X 怎么选、怎么兑换";
export const guidesIndexSeoDescription =
	"老实人AI 使用指南：ChatGPT、Claude、Gemini、X 订阅各规格怎么选，价格、覆盖规则和质保对比，下单兑换步骤；Claude、Google 美国长效接码教程，Apple ID 登录 App Store 方法，各区 App Store 会员价对比和 Claude 网络自查。";

function iso(timestampMs: number) {
	return new Date(timestampMs).toISOString();
}

export function createGuideSeoHead(guide: PublicGuideData, siteName: string) {
	const path = `/guides/${guide.slug}`;
	const url = absoluteSiteUrl(path);
	const title = `${guide.title}｜${siteName}`;
	const head = createDefaultSeoHead({
		title,
		description: guide.description,
		path,
		siteName,
	});
	const organization = {
		"@type": "Organization",
		name: siteName,
		url: absoluteSiteUrl("/"),
	};
	const graph: Record<string, unknown>[] = [
		{
			"@type": "Article",
			headline: guide.title,
			description: guide.description,
			url,
			mainEntityOfPage: url,
			inLanguage: "zh-CN",
			...(guide.publishedAt ? { datePublished: iso(guide.publishedAt) } : {}),
			dateModified: iso(guide.updatedAt),
			author: organization,
			publisher: organization,
		},
		{
			"@type": "BreadcrumbList",
			itemListElement: [
				{
					"@type": "ListItem",
					position: 1,
					name: "首页",
					item: absoluteSiteUrl("/"),
				},
				{
					"@type": "ListItem",
					position: 2,
					name: guidesIndexTitle,
					item: absoluteSiteUrl("/guides"),
				},
				{ "@type": "ListItem", position: 3, name: guide.title, item: url },
			],
		},
	];
	if (guide.faq.length)
		graph.push({
			"@type": "FAQPage",
			mainEntity: guide.faq.map((item) => ({
				"@type": "Question",
				name: item.q,
				acceptedAnswer: { "@type": "Answer", text: item.a },
			})),
		});
	return {
		meta: [
			...head.meta.map((tag) =>
				"property" in tag && tag.property === "og:type"
					? { property: "og:type", content: "article" }
					: tag,
			),
			{ name: "title", content: title },
		],
		links: head.links,
		scripts: [
			jsonLdScript({ "@context": "https://schema.org", "@graph": graph }),
		],
	};
}

export function createGuidesIndexSeoHead(siteName: string) {
	const title = `${guidesIndexSeoTitle}｜${siteName}`;
	const head = createDefaultSeoHead({
		title,
		description: guidesIndexSeoDescription,
		path: "/guides",
		siteName,
	});
	return { ...head, meta: [...head.meta, { name: "title", content: title }] };
}
