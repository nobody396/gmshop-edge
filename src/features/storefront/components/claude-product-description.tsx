const claudeKycTitle = "重要提示｜Claude 身份验证（KYC）";

/**
 * The owner keeps the Claude KYC notice at the top of the product description
 * ("title\nnotice\n\nintro"). Split it out verbatim so the product page can show
 * it in the pre-order notice panel and the rest as the ordinary description.
 */
export function splitClaudeKycNotice(description: string) {
	const separator = description.indexOf("\n\n");
	if (!description.startsWith(`${claudeKycTitle}\n`) || separator < 0)
		return null;
	return {
		title: claudeKycTitle,
		notice: description.slice(claudeKycTitle.length + 1, separator),
		remaining: description.slice(separator + 2),
	};
}

/** The KYC notice as one calm row: the owner's wording, unmarked. */
export function ClaudeKycNotice({
	title,
	notice,
}: {
	title: string;
	notice: string;
}) {
	return (
		<span className="grid gap-1" data-claude-kyc-notice>
			<strong className="font-semibold text-foreground">{title}</strong>
			<span className="whitespace-pre-wrap">{notice}</span>
		</span>
	);
}
