import { describe, expect, it } from "vitest";
import { captureFirstTouch } from "#/features/attribution/first-touch";
import { parseFirstTouchCookie } from "#/features/attribution/server/order-attribution";
import { classifySource } from "#/features/attribution/sources";

describe("order attribution sources", () => {
	it.each([
		["www.baidu.com", "search"],
		["m.baidu.com", "search"],
		["www.so.com", "search"],
		["www.sogou.com", "search"],
		["cn.bing.com", "search"],
		["www.google.com.hk", "search"],
		["www.google.co.jp", "search"],
		["quark.sm.cn", "search"],
		["so.toutiao.com", "search"],
		["www.doubao.com", "ai"],
		["kimi.moonshot.cn", "ai"],
		["www.kimi.com", "ai"],
		["yuanbao.tencent.com", "ai"],
		["chat.deepseek.com", "ai"],
		["chatgpt.com", "ai"],
		["www.perplexity.ai", "ai"],
		["metaso.cn", "ai"],
		["tongyi.aliyun.com", "ai"],
		["yiyan.baidu.com", "ai"],
		["gemini.google.com", "ai"],
		["www.zhihu.com", "social"],
		["www.xiaohongshu.com", "social"],
		["www.douyin.com", "social"],
		["mp.weixin.qq.com", "social"],
		["t.me", "social"],
		["x.com", "social"],
		["lsrai.shop", "other"],
		["notbaidu.com", "other"],
	])("classifies referrer %s as %s", (referrerHost, category) => {
		expect(classifySource({ referrerHost })).toBe(category);
	});

	it("falls back to utm_source, then direct", () => {
		expect(classifySource({ utmSource: "chatgpt.com" })).toBe("ai");
		expect(classifySource({ utmSource: "baidu" })).toBe("search");
		expect(classifySource({ utmSource: "xhs" })).toBe("social");
		expect(classifySource({ utmSource: "newsletter" })).toBe("other");
		expect(
			classifySource({ referrerHost: "lsrai.shop", utmSource: "zhihu" }),
		).toBe("social");
		expect(classifySource({})).toBe("direct");
	});

	it("captures external referrer, campaign tags and the landing path only", () => {
		expect(
			captureFirstTouch({
				href: "https://laoshirenvip.com/products/abc?utm_source=chatgpt.com&utm_medium=referral&utm_campaign=x&secret=1",
				referrer: "https://chatgpt.com/c/123",
				now: 1_000,
			}),
		).toEqual({
			v: 1,
			r: "chatgpt.com",
			s: "chatgpt.com",
			m: "referral",
			c: "x",
			p: "/products/abc",
			t: 1_000,
		});
		expect(
			captureFirstTouch({
				href: "https://laoshirenvip.com/",
				referrer: "https://laoshirenvip.com/products/abc",
				now: 1,
			}).r,
		).toBeUndefined();
	});

	it("reads only a well-formed first-touch cookie", () => {
		const value = encodeURIComponent(
			JSON.stringify({ v: 1, r: "www.baidu.com", p: "/", t: 5 }),
		);
		expect(
			parseFirstTouchCookie(`theme=dark; gmshop_ft=${value}; other=1`),
		).toMatchObject({ r: "www.baidu.com", p: "/", t: 5 });
		expect(parseFirstTouchCookie("gmshop_ft=%7Bbroken")).toBeNull();
		expect(
			parseFirstTouchCookie(
				`gmshop_ft=${encodeURIComponent(JSON.stringify({ v: 2, p: "/" }))}`,
			),
		).toBeNull();
		expect(parseFirstTouchCookie(null)).toBeNull();
	});
});
