/**
 * Campaign tags for links we send ourselves (emails, Telegram). One table so
 * the attribution report groups every channel under consistent names:
 * utm_source = the sending system, utm_medium = the channel type,
 * utm_campaign = the specific message.
 */
export type UtmTag = { source: string; medium: string; campaign: string };

export const ownLinkTags = {
	renewal: (campaign: string): UtmTag => ({
		source: "renewal",
		medium: "email",
		campaign,
	}),
	announcement: (campaign: string): UtmTag => ({
		source: "announcement",
		medium: "email",
		campaign,
	}),
	orderEmail: (campaign: string): UtmTag => ({
		source: "order_email",
		medium: "email",
		campaign,
	}),
	claudeEnv: (campaign: string): UtmTag => ({
		source: "claude_env",
		medium: "email",
		campaign,
	}),
	supportReply: {
		source: "support",
		medium: "email",
		campaign: "support_reply",
	},
	telegramChannel: (campaign: string): UtmTag => ({
		source: "telegram",
		medium: "channel",
		campaign,
	}),
	telegramBot: (campaign: string): UtmTag => ({
		source: "telegram",
		medium: "bot",
		campaign,
	}),
} as const;

const utmKeys = ["utm_source", "utm_medium", "utm_campaign"] as const;

/**
 * Adds utm_* to an absolute or root-relative URL, before any #fragment. A link
 * that already carries any utm_* tag is returned unchanged, and so is anything
 * that does not parse as a URL.
 */
export function withUtm(href: string, tag: UtmTag) {
	const relative = href.startsWith("/") && !href.startsWith("//");
	let url: URL;
	try {
		url = new URL(href, relative ? "https://relative.invalid" : undefined);
	} catch {
		return href;
	}
	if (utmKeys.some((key) => url.searchParams.has(key))) return href;
	// Append instead of re-serializing so existing parameters keep their exact bytes.
	const tags = new URLSearchParams({
		utm_source: tag.source,
		utm_medium: tag.medium,
		utm_campaign: tag.campaign,
	}).toString();
	url.search = url.search.length > 1 ? `${url.search}&${tags}` : `?${tags}`;
	return relative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

// URL characters only (RFC 3986), so CJK punctuation and quotes end a link.
const urlTail = "[A-Za-z0-9\\-._~:/?#@!$&*+,;=%]*";

/**
 * Tags every link to `origin` (and its www. twin) found in free text or HTML.
 * Other hosts — including subdomains such as the redeem site — stay untouched.
 * In HTML mode `&amp;` inside a link is decoded before and re-encoded after.
 */
export function tagOwnLinks(
	content: string,
	origin: string,
	tag: UtmTag,
	mode: "text" | "html" = "text",
) {
	let host: string;
	try {
		host = new URL(origin).hostname.replace(/^www\./, "");
	} catch {
		return content;
	}
	const pattern = new RegExp(
		`https?://(?:www\\.)?${host.replaceAll(".", "\\.")}(?![A-Za-z0-9.-])${urlTail}`,
		"g",
	);
	return content.replace(pattern, (match) => {
		const trailing = /[.,;:!?]+$/.exec(match)?.[0] ?? "";
		let link = trailing ? match.slice(0, -trailing.length) : match;
		if (mode === "html") link = link.replaceAll("&amp;", "&");
		let tagged = withUtm(link, tag);
		if (mode === "html") tagged = tagged.replaceAll("&", "&amp;");
		return `${tagged}${trailing}`;
	});
}
