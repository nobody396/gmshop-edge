import { Fragment } from "react";

const urlPattern = /https:\/\/[^\s<>"'，。；、）)]+/g;

/** Plain product text with its https:// URLs as links; nothing else is parsed. */
export function LinkifiedText({ text }: { text: string }) {
	const parts: React.ReactNode[] = [];
	let last = 0;
	for (const match of text.matchAll(urlPattern)) {
		const url = match[0].replace(/[.,:;!?]+$/, "");
		const start = match.index ?? 0;
		parts.push(
			<Fragment key={`t${start}`}>{text.slice(last, start)}</Fragment>,
		);
		parts.push(
			<a
				key={`a${start}`}
				className="break-all text-primary underline underline-offset-4"
				href={url}
				rel="noopener"
			>
				{url}
			</a>,
		);
		last = start + url.length;
	}
	parts.push(<Fragment key="end">{text.slice(last)}</Fragment>);
	return <>{parts}</>;
}
