import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createDefaultSeoHead,
	createHomeSeoHead,
	siteNameFromMatches,
} from "#/lib/seo";

describe("locale-preserving UI navigation", () => {
	it("keeps local order exits in the router and validates hosted payment exits", () => {
		const source = readFileSync(
			resolve("src/features/storefront/pages/checkout.tsx"),
			"utf8",
		);
		expect(source).toContain("useNavigate");
		expect(source).toContain('to: "/orders/$orderNumber"');
		expect(source).toContain("safeStorePaymentUrl");
		expect(source).toContain("window.location.assign(hostedCheckoutUrl)");
		expect(source).not.toContain("window.location.href");
	});

	it("renders configured site names instead of hard-coded surface brands", () => {
		for (const path of [
			"src/layouts/public/footer.tsx",
			"src/features/home/index.tsx",
		]) {
			const source = readFileSync(resolve(path), "utf8");
			expect(source, path).toContain("brand.name");
		}
		const signIn = readFileSync(
			resolve("src/features/auth/pages/sign-in.tsx"),
			"utf8",
		);
		expect(signIn).not.toContain("GMShop Edge");
	});

	it("uses the root brand in route metadata", () => {
		const siteName = siteNameFromMatches([
			{ loaderData: undefined },
			{ loaderData: { name: "My Store" } },
		]);
		const head = createDefaultSeoHead({ siteName });
		expect(siteName).toBe("My Store");
		expect(head.meta).toContainEqual({
			property: "og:site_name",
			content: "My Store",
		});
		expect(head.meta).toContainEqual({
			name: "twitter:site",
			content: "My Store",
		});
	});

	it("uses configured SEO fields for home sharing metadata", () => {
		const head = createHomeSeoHead([
			{
				loaderData: {
					name: "My Store",
					title: "Configured home title",
					description: "Store description",
					seoDescription: "Configured SEO description",
				},
			},
		]);

		expect(head.meta).toContainEqual({ title: "Configured home title" });
		for (const attribute of [
			{ name: "description" },
			{ property: "og:description" },
			{ name: "twitter:description" },
		]) {
			expect(head.meta).toContainEqual({
				...attribute,
				content: "Configured SEO description",
			});
		}
		expect(head.meta).toContainEqual({
			property: "og:title",
			content: "Configured home title",
		});
		expect(head.meta).toContainEqual({
			name: "twitter:title",
			content: "Configured home title",
		});
	});

	it("publishes one canonical URL without locale-prefixed alternates", () => {
		const head = createHomeSeoHead([]);

		expect(head.links).toHaveLength(1);
		expect(head.links[0]).toMatchObject({ rel: "canonical" });
		expect(head.links[0]).not.toHaveProperty("hrefLang");
	});
});
