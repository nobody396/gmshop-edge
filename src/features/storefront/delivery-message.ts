export type DeliveryMessagePart = {
	text: string;
	href?: string;
	offset: number;
};

/** Preserve customer-facing text; make only explicit HTTP(S) URLs clickable. */
export function splitDeliveryMessage(content: string): DeliveryMessagePart[] {
	const parts: DeliveryMessagePart[] = [];
	let cursor = 0;
	for (const match of content.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
		const text = match[0].replace(/[.,，。;；!！?？)）\]】]+$/, "");
		if (text.length > 2048) continue;
		let url: URL;
		try {
			url = new URL(text);
		} catch {
			continue;
		}
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password
		)
			continue;
		if (match.index > cursor)
			parts.push({ text: content.slice(cursor, match.index), offset: cursor });
		parts.push({ text, href: url.href, offset: match.index });
		cursor = match.index + text.length;
	}
	if (cursor < content.length)
		parts.push({ text: content.slice(cursor), offset: cursor });
	return parts;
}

export type DeliveryCode = {
	/** Original line prefix including the separator, e.g. "CDK：". */
	label: string;
	value: string;
};

export type StructuredDelivery = {
	codes: DeliveryCode[];
	/** `line` is the original labelled line, or null when the entry only came from `usageUrl`. */
	redeem: { href: string; line: string | null } | null;
	/** Every line that is neither a recognised code nor the redeem line, in order. */
	rest: string;
};

const codeLinePattern =
	/^\s*((?:CDK|卡密|兑换码)\s*\d{0,3}\s*[:：]\s*)(\S{4,256})\s*$/i;
const redeemLinePattern =
	/^\s*(?:充值地址|兑换地址|兑换页面?)\s*[:：]\s*(https?:\/\/\S+)\s*$/i;

/** A safe HTTP(S) link starting at the very beginning of `text`. */
function leadingHref(text: string) {
	const [first] = splitDeliveryMessage(text);
	return first?.href && first.offset === 0 ? first.href : null;
}

/**
 * Conservatively recognise labelled card codes and a labelled redeem URL.
 * Returns null unless at least one code line is recognised, so other shapes
 * (accounts, gift links, free text) keep the raw rendering. Nothing is
 * rewritten: code labels, the redeem line and all other lines stay verbatim.
 */
export function parseStructuredDelivery(
	content: string,
	usageUrl?: string | null,
): StructuredDelivery | null {
	const codes: DeliveryCode[] = [];
	let redeem: StructuredDelivery["redeem"] = null;
	const rest: string[] = [];
	for (const line of content.split("\n")) {
		const code = codeLinePattern.exec(line);
		if (code?.[1] && code[2] && !/^https?:/i.test(code[2])) {
			codes.push({ label: code[1].trim(), value: code[2] });
			continue;
		}
		const labelled: string | null | undefined = redeem
			? null
			: redeemLinePattern.exec(line)?.[1];
		const href: string | null = labelled ? leadingHref(labelled) : null;
		if (href) {
			redeem = { href, line: line.trim() };
			continue;
		}
		rest.push(line);
	}
	if (!codes.length) return null;
	if (!redeem && usageUrl) {
		const href = leadingHref(usageUrl);
		if (href && splitDeliveryMessage(usageUrl).length === 1)
			redeem = { href, line: null };
	}
	return {
		codes,
		redeem,
		rest: rest
			.join("\n")
			.replace(/^(?:[ \t\r]*\n)+/, "")
			.trimEnd(),
	};
}
