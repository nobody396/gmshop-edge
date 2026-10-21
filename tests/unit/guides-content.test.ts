import { describe, expect, it } from "vitest";
import {
	beijingDate,
	guideSlugSchema,
	reservedGuideSlugs,
} from "#/features/guides/content";
import { renderGuideMarkdown } from "#/features/guides/server/markdown";
import {
	findGuideBannedWords,
	GUIDE_BANNED_WORDS,
	guideUpsertSchema,
} from "#/features/guides/server/rules";
import {
	collectGuideTokens,
	GUIDE_OUT_OF_STOCK_LABEL,
	replaceGuideTokens,
} from "#/features/guides/tokens";
import { handleIndexNowKeyRequest } from "#/features/seo/server/indexnow";

describe("guide banned words", () => {
	it("keeps the full list in one constant", () => {
		expect(GUIDE_BANNED_WORDS).toEqual([
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
		]);
	});

	it("matches across case, full-width characters and whitespace", () => {
		expect(findGuideBannedWords(["开个 vpn 就行"])).toEqual(["VPN"]);
		expect(findGuideBannedWords(["保证 １００％ 不封"])).toEqual(["100%不封"]);
		expect(findGuideBannedWords(["来自 aisou 的货", "98-XJ"])).toEqual([
			"AISOU",
			"98-xj",
		]);
		expect(findGuideBannedWords(["科 学 上 网", "共享号合租"])).toEqual([
			"科学上网",
			"共享号",
			"合租",
		]);
	});

	it("passes ordinary purchase guidance", () => {
		expect(
			findGuideBannedWords([
				"ChatGPT Plus 充值教程",
				"付款后在订单页领取卡密，按提示兑换即可。",
			]),
		).toEqual([]);
	});
});

describe("guide slugs and payloads", () => {
	it("accepts lowercase hyphenated slugs only", () => {
		for (const slug of ["chatgpt-plus", "a1", "claude-pro-2026"])
			expect(guideSlugSchema.safeParse(slug).success, slug).toBe(true);
		for (const slug of [
			"A",
			"ChatGPT",
			"-lead",
			"trail-",
			"double--dash",
			"under_score",
			"中文",
			"a".repeat(81),
			"x",
		])
			expect(guideSlugSchema.safeParse(slug).success, slug).toBe(false);
	});

	it("reserves the hand-built guide routes", () => {
		expect(reservedGuideSlugs.has("apple-id-login")).toBe(true);
		expect(reservedGuideSlugs.has("claude-network-check")).toBe(true);
	});

	it("limits title, description, body and faq size", () => {
		const base = { title: "标题", description: "描述", bodyMd: "正文" };
		expect(guideUpsertSchema.parse(base)).toMatchObject({
			faq: [],
			relatedProductIds: [],
			source: "manual",
		});
		expect(
			guideUpsertSchema.safeParse({ ...base, title: "字".repeat(61) }).success,
		).toBe(false);
		expect(
			guideUpsertSchema.safeParse({ ...base, description: "字".repeat(161) })
				.success,
		).toBe(false);
		expect(
			guideUpsertSchema.safeParse({ ...base, bodyMd: "x".repeat(60_001) })
				.success,
		).toBe(false);
		expect(
			guideUpsertSchema.safeParse({
				...base,
				faq: Array.from({ length: 21 }, (_, index) => ({
					q: `问${index}`,
					a: "答",
				})),
			}).success,
		).toBe(false);
	});

	it("formats dates in Beijing time", () => {
		// 2026-10-20 23:30 UTC is already 2026-10-21 in Beijing.
		expect(beijingDate(Date.UTC(2026, 9, 20, 23, 30))).toBe("2026-10-21");
	});
});

describe("guide live tokens", () => {
	const values = {
		prices: new Map<string, string | null>([
			["item-plus", "¥139.00"],
			["item-off", null],
		]),
		products: new Map([["prod-1", { name: "ChatGPT [Plus] 充值" }]]),
	};

	it("collects distinct ids from well-formed tokens", () => {
		expect(
			collectGuideTokens(
				"{{price:item-plus}} {{ price : item-plus }} {{product:prod-1}} {{bad}}",
			),
		).toEqual({ priceIds: ["item-plus"], productIds: ["prod-1"] });
	});

	it("replaces prices, sold-out plans and product links", () => {
		const result = replaceGuideTokens(
			"现价 {{price:item-plus}}，旧款 {{price:item-off}}，购买 {{product:prod-1}}。",
			values,
		);
		expect(result.markdown).toBe(
			`现价 ¥139.00，旧款 ${GUIDE_OUT_OF_STOCK_LABEL}，购买 [ChatGPT \\[Plus\\] 充值](/products/prod-1)。`,
		);
		expect(result.unknownTokens).toEqual([]);
	});

	it("removes unknown tokens instead of showing them", () => {
		const result = replaceGuideTokens(
			"A{{price:missing}}B{{product:gone}}C{{coupon:x}}D{{}}E",
			values,
		);
		expect(result.markdown).toBe("ABCDE");
		expect(result.unknownTokens).toEqual([
			"{{price:missing}}",
			"{{product:gone}}",
			"{{coupon:x}}",
			"{{}}",
		]);
	});
});

describe("guide markdown rendering", () => {
	it("renders GFM and keeps the page title the only h1", () => {
		const html = renderGuideMarkdown(
			"# 标题\n\n## 步骤\n\n- 一\n- 二\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[商品](/products/x)",
		);
		expect(html).not.toContain("<h1");
		expect(html).toContain("<h2>标题</h2>");
		expect(html).toContain("<li>一</li>");
		expect(html).toContain("<table>");
		expect(html).toContain('<a href="/products/x">商品</a>');
	});

	it("drops raw HTML, scripts, event handlers and javascript: links", () => {
		const html = renderGuideMarkdown(
			[
				"<script>alert(1)</script>",
				'<img src="x" onerror="alert(1)">',
				'<iframe src="https://evil.example"></iframe>',
				"[点我](javascript:alert(1))",
				"![图](javascript:alert(1))",
				'<a href="https://evil.example" onclick="x()">链接</a>',
			].join("\n\n"),
		);
		expect(html).not.toMatch(/<script|onerror|onclick|<iframe|javascript:/i);
		expect(html).not.toContain("alert(1)</script>");
	});

	it("marks external links nofollow and leaves site links alone", () => {
		const html = renderGuideMarkdown(
			"[外部](https://example.com) [本站](https://laoshirenvip.com/orders)",
		);
		expect(html).toContain(
			'<a href="https://example.com" rel="nofollow noopener noreferrer">外部</a>',
		);
		expect(html).toContain(
			'<a href="https://laoshirenvip.com/orders">本站</a>',
		);
	});
});

describe("IndexNow key file", () => {
	const key = "c6a31b5038fd9666c1c5117f759e479c";

	it("serves exactly the key at /<key>.txt", async () => {
		const response = handleIndexNowKeyRequest(
			new Request(`https://laoshirenvip.com/${key}.txt`),
			key,
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toBe(
			"text/plain; charset=utf-8",
		);
		await expect(response?.text()).resolves.toBe(key);
	});

	it("ignores every other path and a missing key", () => {
		for (const path of [
			"/robots.txt",
			`/${key}.txt/x`,
			`/${key}`,
			"/llms.txt",
			`/guides/${key}.txt`,
		])
			expect(
				handleIndexNowKeyRequest(
					new Request(`https://laoshirenvip.com${path}`),
					key,
				),
				path,
			).toBeNull();
		expect(
			handleIndexNowKeyRequest(
				new Request(`https://laoshirenvip.com/${key}.txt`),
				undefined,
			),
		).toBeNull();
	});
});
