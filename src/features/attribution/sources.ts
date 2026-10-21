export const sourceCategories = [
	"search",
	"ai",
	"social",
	"direct",
	"other",
] as const;

export type SourceCategory = (typeof sourceCategories)[number];

// AI assistants come first: several live on search-engine domains
// (yiyan.baidu.com, gemini.google.com).
const aiHosts = [
	"doubao.com",
	"kimi.moonshot.cn",
	"kimi.com",
	"yuanbao.tencent.com",
	"deepseek.com",
	"chatgpt.com",
	"chat.openai.com",
	"perplexity.ai",
	"metaso.cn",
	"tongyi.aliyun.com",
	"qianwen.aliyun.com",
	"tongyi.com",
	"qwen.ai",
	"yiyan.baidu.com",
	"gemini.google.com",
	"claude.ai",
	"copilot.microsoft.com",
	"grok.com",
	"poe.com",
	"chatglm.cn",
	"xinghuo.xfyun.cn",
	"hailuoai.com",
	"tiangong.cn",
];

const searchHosts = [
	"baidu.com",
	"so.com",
	"sogou.com",
	"bing.com",
	"sm.cn",
	"toutiao.com",
	"duckduckgo.com",
	"yandex.com",
	"yandex.ru",
	"yahoo.com",
	"naver.com",
];

const socialHosts = [
	"zhihu.com",
	"xiaohongshu.com",
	"xhslink.com",
	"douyin.com",
	"weixin.qq.com",
	"qq.com",
	"t.me",
	"telegram.org",
	"x.com",
	"twitter.com",
	"t.co",
	"weibo.com",
	"weibo.cn",
	"bilibili.com",
	"b23.tv",
	"reddit.com",
	"youtube.com",
	"facebook.com",
	"instagram.com",
	"tiktok.com",
];

const utmKeywords: Array<[SourceCategory, RegExp]> = [
	[
		"ai",
		/^(chatgpt|openai|perplexity|doubao|kimi|moonshot|deepseek|yuanbao|metaso|tongyi|qwen|qianwen|yiyan|wenxin|ernie|gemini|claude|copilot|grok|poe|chatglm)/,
	],
	["search", /^(baidu|google|bing|sogou|360|so|sm|shenma|toutiao|duckduckgo)/],
	[
		"social",
		/^(zhihu|xiaohongshu|xhs|douyin|wechat|weixin|wx|qq|telegram|tg|twitter|x|weibo|bilibili|reddit|youtube|tiktok)/,
	],
];

function matchesHost(host: string, domain: string) {
	return host === domain || host.endsWith(`.${domain}`);
}

export function classifyHost(
	host: string | null | undefined,
): SourceCategory | null {
	const value = host?.trim().toLowerCase().replace(/\.$/, "");
	if (!value) return null;
	if (aiHosts.some((domain) => matchesHost(value, domain))) return "ai";
	if (
		searchHosts.some((domain) => matchesHost(value, domain)) ||
		/(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(value)
	)
		return "search";
	if (socialHosts.some((domain) => matchesHost(value, domain))) return "social";
	return "other";
}

function classifyUtmSource(
	source: string | null | undefined,
): SourceCategory | null {
	const value = source?.trim().toLowerCase();
	if (!value) return null;
	if (value.includes(".")) return classifyHost(value);
	return utmKeywords.find(([, pattern]) => pattern.test(value))?.[0] ?? "other";
}

/**
 * Buckets a first touch: a known referrer wins, then an explicit utm_source;
 * no referrer and no campaign tags is a direct visit.
 */
export function classifySource(input: {
	referrerHost?: string | null;
	utmSource?: string | null;
}): SourceCategory {
	const fromReferrer = classifyHost(input.referrerHost);
	if (fromReferrer && fromReferrer !== "other") return fromReferrer;
	const fromUtm = classifyUtmSource(input.utmSource);
	if (fromUtm && fromUtm !== "other") return fromUtm;
	return fromReferrer || fromUtm ? "other" : "direct";
}
