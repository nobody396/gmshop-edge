/**
 * What the App Store price comparison shows. Client-safe: the page, the
 * ingest endpoint and the tests all read this one table.
 *
 * To add or rename a tier, edit `appStorePriceApps`: `appleNames` are the exact
 * In-App Purchase names on apps.apple.com (case and spacing ignored), and
 * `otrPlan` is the plan id in OpenTheRank's App Store table (monthly only).
 */

export const appStoreRegions = [
	{ id: "us", label: "美区", labelEn: "US", currency: "USD" },
	{ id: "jp", label: "日区", labelEn: "Japan", currency: "JPY" },
	{ id: "ph", label: "菲区", labelEn: "Philippines", currency: "PHP" },
	{ id: "tr", label: "土区", labelEn: "Türkiye", currency: "TRY" },
] as const;

export type AppStoreRegionId = (typeof appStoreRegions)[number]["id"];
export type AppStoreCurrency = (typeof appStoreRegions)[number]["currency"];

export const appStoreRegionIds = appStoreRegions.map(
	(region) => region.id,
) as AppStoreRegionId[];

export type AppStorePeriod = "month" | "year";

export type AppStoreTierConfig = {
	id: string;
	label: string;
	labelEn: string;
	period: AppStorePeriod;
	/** Exact In-App Purchase names that mean this tier. */
	appleNames: readonly string[];
	/** OpenTheRank plan id; only for monthly tiers. */
	otrPlan?: string;
	/** Optional small print under the tier name. */
	hint?: string;
	hintEn?: string;
};

export type AppStoreAppConfig = {
	id: "chatgpt" | "claude" | "gemini";
	title: string;
	titleEn: string;
	appleSlug: string;
	appleId: number;
	tiers: readonly AppStoreTierConfig[];
};

export const appStorePriceApps: readonly AppStoreAppConfig[] = [
	{
		id: "chatgpt",
		title: "ChatGPT",
		titleEn: "ChatGPT",
		appleSlug: "chatgpt",
		appleId: 6448311069,
		tiers: [
			{
				id: "go",
				label: "Go",
				labelEn: "Go",
				period: "month",
				appleNames: ["ChatGPT Go"],
			},
			{
				id: "plus",
				label: "Plus",
				labelEn: "Plus",
				period: "month",
				appleNames: ["ChatGPT Plus"],
				otrPlan: "plus",
			},
			{
				id: "plus-year",
				label: "Plus",
				labelEn: "Plus",
				period: "year",
				appleNames: ["ChatGPT Plus"],
			},
			{
				id: "pro-100",
				label: "Pro 100",
				labelEn: "Pro 100",
				period: "month",
				appleNames: ["ChatGPT Pro 100"],
				otrPlan: "pro-5x",
			},
			{
				id: "pro-200",
				label: "Pro 200",
				labelEn: "Pro 200",
				period: "month",
				appleNames: ["ChatGPT Pro 200"],
				otrPlan: "pro",
			},
			{
				id: "pro-500",
				label: "Pro 500",
				labelEn: "Pro 500",
				period: "month",
				appleNames: ["ChatGPT Pro 500"],
				otrPlan: "pro-max",
			},
		],
	},
	{
		id: "claude",
		title: "Claude",
		titleEn: "Claude",
		appleSlug: "claude-by-anthropic",
		appleId: 6473753684,
		tiers: [
			{
				id: "pro",
				label: "Pro",
				labelEn: "Pro",
				period: "month",
				appleNames: ["Claude Pro - Monthly", "Claude Pro"],
				otrPlan: "pro",
			},
			{
				id: "pro-year",
				label: "Pro",
				labelEn: "Pro",
				period: "year",
				appleNames: ["Claude Pro - Annual", "Claude Pro"],
			},
			{
				id: "max-5x",
				label: "Max",
				labelEn: "Max",
				period: "month",
				appleNames: ["Claude Max - Monthly", "Claude Max"],
				otrPlan: "max",
				hint: "官方 $100 档，Pro 的 5 倍用量（原 Max 5x）",
				hintEn: "Official $100 tier, 5x Pro usage (formerly Max 5x)",
			},
			{
				id: "max-20x",
				label: "Ultra",
				labelEn: "Ultra",
				period: "month",
				appleNames: ["Claude Ultra - Monthly", "Claude Ultra"],
				otrPlan: "max-20x",
				hint: "官方 $200 档，每周 Pro 的 10 倍、无 5 小时限制（原 Max 20x）",
				hintEn: "Official $200 tier, 10x Pro weekly usage, no 5-hour limit (formerly Max 20x)",
			},
		],
	},
	{
		id: "gemini",
		title: "Google AI（Gemini App）",
		titleEn: "Google AI (Gemini app)",
		appleSlug: "google-gemini",
		appleId: 6477489729,
		tiers: [
			{
				id: "plus",
				label: "Google AI Plus",
				labelEn: "Google AI Plus",
				period: "month",
				appleNames: ["Google AI Plus (400 GB)", "Google AI Plus"],
				otrPlan: "plus",
			},
			{
				id: "plus-year",
				label: "Google AI Plus",
				labelEn: "Google AI Plus",
				period: "year",
				appleNames: ["Google AI Plus (400 GB)", "Google AI Plus"],
			},
			{
				id: "pro",
				label: "Google AI Pro",
				labelEn: "Google AI Pro",
				period: "month",
				appleNames: [
					"Google AI Pro (5 TB)",
					"Google AI Pro (2 TB)",
					"Google AI Pro",
				],
				otrPlan: "pro",
			},
			{
				id: "pro-year",
				label: "Google AI Pro",
				labelEn: "Google AI Pro",
				period: "year",
				appleNames: [
					"Google AI Pro (5 TB)",
					"Google AI Pro (2 TB)",
					"Google AI Pro",
				],
			},
			{
				id: "ultra",
				label: "Google AI Ultra",
				labelEn: "Google AI Ultra",
				period: "month",
				appleNames: ["Google AI Ultra (30 TB)", "Google AI Ultra"],
				otrPlan: "ultra",
			},
		],
	},
];

export const appStorePricesPath = "/guides/appstore-prices";
export const appStorePricesApiPath = "/api/public/appstore-prices";
