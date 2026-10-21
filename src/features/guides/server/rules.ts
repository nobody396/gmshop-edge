import { z } from "zod";

/**
 * Server-only write rules for guides. Kept out of the client bundle: the
 * banned list names upstream suppliers that must never reach the browser.
 */

/**
 * Words that must never appear in a published guide: risky circumvention or
 * account-sharing language, absolute promises, false endorsements, and
 * upstream supplier names. Matching ignores case, width and whitespace.
 */
export const GUIDE_BANNED_WORDS = [
	"翻墙",
	"梯子",
	"科学上网",
	"VPN",
	"破解",
	"共享号",
	"合租",
	"拼车",
	"100%不封",
	"永不封号",
	"绝对安全",
	"官方授权",
	"官方合作",
	"小九",
	"AISOU",
	"98-xj",
	"982xj",
] as const;

function normalizeForBannedMatch(value: string) {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

const normalizedBannedWords = GUIDE_BANNED_WORDS.map((word) => ({
	word,
	needle: normalizeForBannedMatch(word),
}));

/** Returns the banned words found in any of the texts, in list order. */
export function findGuideBannedWords(texts: readonly string[]): string[] {
	const haystack = texts.map(normalizeForBannedMatch).join("\n");
	return normalizedBannedWords
		.filter(({ needle }) => haystack.includes(needle))
		.map(({ word }) => word);
}

export function guideTexts(guide: {
	title: string;
	description: string;
	bodyMd: string;
	faq: readonly GuideFaqItem[];
}) {
	return [
		guide.title,
		guide.description,
		guide.bodyMd,
		...guide.faq.flatMap((item) => [item.q, item.a]),
	];
}

export const guideFaqItemSchema = z.object({
	q: z.string().trim().min(1).max(200),
	a: z.string().trim().min(1).max(2_000),
});

export type GuideFaqItem = z.infer<typeof guideFaqItemSchema>;

export const guideUpsertSchema = z.object({
	title: z.string().trim().min(1).max(60),
	description: z.string().trim().min(1).max(160),
	bodyMd: z.string().min(1).max(60_000),
	faq: z.array(guideFaqItemSchema).max(20).default([]),
	relatedProductIds: z.array(z.uuid()).max(12).default([]),
	source: z.enum(["manual", "auto"]).default("manual"),
	revision: z.number().int().positive().optional(),
});

export type GuideUpsertInput = z.infer<typeof guideUpsertSchema>;
