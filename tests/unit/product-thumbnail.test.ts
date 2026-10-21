import { describe, expect, it } from "vitest";
import { productCoverResponse } from "#/features/storefront/server/product-cover";
import { productThumbnailUrl } from "#/features/storefront/thumbnail";

const db = {
	prepare: () => ({
		bind: () => ({
			first: async () => ({ cover_object_key: "covers/banner.webp" }),
		}),
	}),
} as unknown as D1Database;

function bucket(keys: string[]) {
	const requested: string[] = [];
	const store = {
		requested,
		get: async (key: string) => {
			requested.push(key);
			if (!keys.includes(key)) return null;
			return {
				httpEtag: `"${key}"`,
				body: key,
				writeHttpMetadata: () => undefined,
			};
		},
	};
	return store as unknown as R2Bucket & { requested: string[] };
}

describe("product thumbnails", () => {
	it("adds the thumb flag to a versioned cover URL", () => {
		expect(productThumbnailUrl("/api/shop/products/p1/cover?v=1")).toBe(
			"/api/shop/products/p1/cover?v=1&thumb=1",
		);
	});
	it("serves the square thumbnail when one exists", async () => {
		const files = bucket(["product-thumbs/p1.webp", "covers/banner.webp"]);
		const res = await productCoverResponse(
			new Request("https://shop.test/api/shop/products/p1/cover?thumb=1"),
			"p1",
			db,
			files,
		);
		expect(await res.text()).toBe("product-thumbs/p1.webp");
	});
	it("falls back to the cover without a thumbnail, and ignores thumbs without the flag", async () => {
		const files = bucket(["covers/banner.webp", "product-thumbs/p1.webp"]);
		const plain = await productCoverResponse(
			new Request("https://shop.test/api/shop/products/p1/cover"),
			"p1",
			db,
			files,
		);
		expect(await plain.text()).toBe("covers/banner.webp");
		const missing = bucket(["covers/banner.webp"]);
		const fallback = await productCoverResponse(
			new Request("https://shop.test/api/shop/products/p1/cover?thumb=1"),
			"p1",
			db,
			missing,
		);
		expect(await fallback.text()).toBe("covers/banner.webp");
	});
});
