import { defaultSiteBrand } from "#/features/settings/site-brand";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { absoluteSiteUrl } from "./site-url";

type DefaultSeoInput = {
	title?: string;
	description?: string;
	path?: string;
	siteName?: string;
};

export function createDefaultSeoHead(input: DefaultSeoInput = {}) {
	const siteName = input.siteName ?? defaultSiteBrand.name;
	const title = input.title ?? `${siteName} – ${m.app_title_description()}`;
	const description = input.description ?? m.common_seo_description();
	const url = absoluteSiteUrl(input.path ?? "/");

	return {
		meta: [
			{
				title,
			},
			{
				name: "description",
				content: description,
			},
			{
				property: "og:type",
				content: "website",
			},
			{
				property: "og:site_name",
				content: siteName,
			},
			{
				property: "og:url",
				content: url,
			},
			{
				property: "og:locale",
				content: getLocale().replace("-", "_"),
			},
			{
				property: "og:title",
				content: title,
			},
			{
				property: "og:description",
				content: description,
			},
			{
				name: "twitter:card",
				content: "summary",
			},
			{
				name: "twitter:site",
				content: siteName,
			},
			{
				name: "twitter:title",
				content: title,
			},
			{
				name: "twitter:description",
				content: description,
			},
		],
		links: [
			{
				rel: "canonical",
				href: url,
			},
		],
	};
}

export function createHomeSeoHead(matches: readonly RouteLoaderMatch[]) {
	const siteName = siteNameFromMatches(matches);
	const head = createDefaultSeoHead({
		siteName,
		title:
			stringSettingFromMatches(matches, "title") ??
			`${siteName} – ${m.app_title_description()}`,
		description:
			stringSettingFromMatches(matches, "seoDescription") ??
			stringSettingFromMatches(matches, "description") ??
			m.common_seo_description(),
		path: "/",
	});

	const logo = stringSettingFromMatches(matches, "logoUrl") ?? "/favicon.png";
	return {
		meta: head.meta,
		links: head.links,
		scripts: [
			jsonLdScript({
				"@context": "https://schema.org",
				"@graph": [
					{
						"@type": "Organization",
						"@id": absoluteSiteUrl("/#organization"),
						name: siteName,
						url: absoluteSiteUrl("/"),
						logo: absoluteSiteUrl(logo),
					},
					{
						"@type": "WebSite",
						"@id": absoluteSiteUrl("/#website"),
						name: siteName,
						url: absoluteSiteUrl("/"),
						inLanguage: getLocale(),
						publisher: { "@id": absoluteSiteUrl("/#organization") },
						potentialAction: {
							"@type": "SearchAction",
							target: {
								"@type": "EntryPoint",
								urlTemplate: `${absoluteSiteUrl("/")}?search={search_term_string}`,
							},
							"query-input": "required name=search_term_string",
						},
					},
				],
			}),
		],
	};
}

/** JSON inside <script> must not be able to close the element. */
export function jsonLdScript(value: unknown) {
	return {
		type: "application/ld+json",
		children: JSON.stringify(value)
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e")
			.replace(/&/g, "\\u0026"),
	};
}

type RouteLoaderMatch = { loaderData?: unknown };

export function siteNameFromMatches(matches: readonly RouteLoaderMatch[]) {
	return stringSettingFromMatches(matches, "name") ?? defaultSiteBrand.name;
}

function stringSettingFromMatches(
	matches: readonly RouteLoaderMatch[],
	key: string,
) {
	for (const match of matches) {
		const loaderData = match.loaderData;
		if (!loaderData || typeof loaderData !== "object" || !(key in loaderData))
			continue;
		const value = (loaderData as Record<string, unknown>)[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

export function createArticleSeoHead(
	matches: readonly RouteLoaderMatch[],
	input: { title: string; description: string; path: string },
) {
	const siteName = siteNameFromMatches(matches);
	const head = createDefaultSeoHead({ ...input, siteName });
	const url = absoluteSiteUrl(input.path);
	return {
		meta: head.meta.map((tag) =>
			"property" in tag && tag.property === "og:type"
				? { property: "og:type", content: "article" }
				: tag,
		),
		links: head.links,
		scripts: [
			jsonLdScript({
				"@context": "https://schema.org",
				"@type": "Article",
				headline: input.title,
				description: input.description,
				url,
				mainEntityOfPage: url,
				inLanguage: getLocale(),
				publisher: {
					"@type": "Organization",
					name: siteName,
					url: absoluteSiteUrl("/"),
				},
			}),
		],
	};
}
