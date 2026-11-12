import { z } from "zod";

// Fixed replies for web-support messages that contain a known order code
// prefix (e.g. a ready-made account reservation code). Configured in D1 so
// the text can change without a deploy; invalid settings disable the feature.
export const supportCodeReplySettingKey = "telegram.support.code_auto_replies";

const ruleSchema = z.object({
	prefixes: z.array(z.string().trim().min(4).max(64)).min(1).max(20),
	message: z.string().trim().min(1).max(1500),
});
const settingSchema = z.array(ruleSchema).max(20);
export type SupportCodeReplyRule = z.infer<typeof ruleSchema>;

export function parseSupportCodeReplyRules(raw: string | null | undefined) {
	try {
		const parsed = settingSchema.safeParse(JSON.parse(raw ?? "[]"));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

export async function loadSupportCodeReplyRules(db: D1Database) {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key=?")
		.bind(supportCodeReplySettingKey)
		.first<{ value: string }>();
	return parseSupportCodeReplyRules(row?.value);
}

/** First rule whose prefix appears in the text (case-insensitive). */
export function matchSupportCodeReply(
	rules: readonly SupportCodeReplyRule[],
	text: string,
) {
	const haystack = text.toLowerCase();
	for (const [index, rule] of rules.entries())
		if (rule.prefixes.some((prefix) => haystack.includes(prefix.toLowerCase())))
			return { index, message: rule.message };
	return null;
}
