/** Category order shared by the storefront sidebar and the referral table. Must match CATEGORY_META in category-sidebar.tsx. */
export const CATEGORY_ORDER = [
	"Anthropic",
	"OpenAI",
	"X",
	"Gemini",
	"Telegram",
	"Apple",
	"邮箱",
	"接码",
	"开店赚钱",
	"其他服务",
];

export type CatalogTag = { name: string; productCount: number };

export function orderedCategories(tags: readonly CatalogTag[]) {
	const rank = (name: string) => {
		const index = CATEGORY_ORDER.indexOf(name);
		return index < 0 ? CATEGORY_ORDER.length : index;
	};
	return [...tags].sort(
		(a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
	);
}

/** The category a product is listed under: its first tag in sidebar order. */
export function primaryCategory(tagNames: readonly string[]) {
	return orderedCategories(
		tagNames.map((name) => ({ name, productCount: 0 })),
	)[0]?.name;
}
