export const sourceCategories = [
	"search",
	"ai",
	"social",
	"email",
	"referral",
	"wechat_in_app",
	"telegram_in_app",
	"qq_in_app",
	"direct",
	"other",
] as const;

export type SourceCategory = (typeof sourceCategories)[number];

export const inAppBrowsers = ["wechat", "telegram", "qq"] as const;
export type InAppBrowser = (typeof inAppBrowsers)[number];

/** Invite links are `/?ref=INV-…`; renewal and cross-sell links reuse `ref` for other values. */
export function isInviteRef(value: string | null | undefined) {
	return /^INV-[A-Z0-9]{20}$/i.test(value?.trim() ?? "");
}

/**
 * The in-app browser a page was opened in, from the User-Agent (plus the
 * `TelegramWebviewProxy` bridge Telegram injects; its iOS browser keeps
 * Safari's User-Agent). Null for ordinary browsers.
 */
export function detectInAppBrowser(
	userAgent: string | null | undefined,
	telegramWebview = false,
): InAppBrowser | null {
	const ua = userAgent ?? "";
	if (/MicroMessenger/i.test(ua)) return "wechat";
	if (telegramWebview || /Telegram/i.test(ua)) return "telegram";
	if (/\sQQ\/\d/.test(ua)) return "qq";
	return null;
}

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

// Hosts our own flows bounce through: payment checkouts, the sign-in providers
// auth-factory can enable (Google, Apple, Microsoft, LINE, WeChat, Telegram)
// and human-verification challenges. Arriving from one is a return, never a
// marketing touch. GitHub and Discord sign-in share their hosts with real
// referrers, so those returns are recognized by markAuthRedirect instead.
const flowHosts = [
	"alipay.com",
	"alipayobjects.com",
	"stripe.com",
	"cryptomus.com",
	"zpayz.cn",
	"tenpay.com",
	"pay.weixin.qq.com",
	"paypal.com",
	"accounts.youtube.com",
	"appleid.apple.com",
	"login.microsoftonline.com",
	"login.microsoft.com",
	"login.live.com",
	"access.line.me",
	"open.weixin.qq.com",
	"oauth.telegram.org",
	"challenges.cloudflare.com",
];

/** Payment, sign-in or challenge host (see flowHosts), including accounts.google.* */
export function isFlowHost(host: string | null | undefined) {
	const value = host?.trim().toLowerCase().replace(/\.$/, "");
	if (!value) return false;
	return (
		flowHosts.some((domain) => matchesHost(value, domain)) ||
		/(^|\.)accounts\.google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(value)
	);
}

export function classifyHost(
	host: string | null | undefined,
): SourceCategory | null {
	const value = host?.trim().toLowerCase().replace(/\.$/, "");
	// A flow host (sign-in, payment, challenge) is no referrer at all.
	if (!value || isFlowHost(value)) return null;
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
 * Buckets a touch. Our own email links (utm_medium=email) win, since webmail
 * referrers look like search or social; then an invite link without campaign
 * tags; then a known referrer, then an explicit utm_source. With no referrer
 * and no tags the in-app browser splits "direct" (WeChat, Telegram, QQ).
 */
export function classifySource(input: {
	referrerHost?: string | null;
	utmSource?: string | null;
	utmMedium?: string | null;
	invite?: boolean | null;
	inApp?: InAppBrowser | null;
}): SourceCategory {
	if (input.utmMedium?.trim().toLowerCase() === "email") return "email";
	if (input.invite && !input.utmSource?.trim()) return "referral";
	const fromReferrer = classifyHost(input.referrerHost);
	if (fromReferrer && fromReferrer !== "other") return fromReferrer;
	const fromUtm = classifyUtmSource(input.utmSource);
	if (fromUtm && fromUtm !== "other") return fromUtm;
	if (fromReferrer || fromUtm) return "other";
	return input.inApp ? `${input.inApp}_in_app` : "direct";
}
