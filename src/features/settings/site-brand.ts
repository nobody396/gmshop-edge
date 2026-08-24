import type { SupportedLocale } from "#/lib/locales";

export type SiteBrand = {
	name: string;
	description?: string;
	logoUrl: string;
	title: string;
	seoDescription?: string;
	customHtml: string;
	defaultLocale: SupportedLocale;
};

export const defaultSiteBrand: SiteBrand = {
	name: "老实人AI",
	logoUrl: "/favicon.png",
	title: "老实人AI 商城",
	customHtml: "",
	defaultLocale: "zh-CN",
};
