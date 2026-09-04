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
