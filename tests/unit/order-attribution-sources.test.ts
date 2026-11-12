import { describe, expect, it } from "vitest";
import {
	captureFirstTouch,
	lastTouchFrom,
} from "#/features/attribution/first-touch";
import {
	parseFirstTouchCookie,
	parseLastTouchCookie,
} from "#/features/attribution/server/order-attribution";
import {
	classifySource,
	detectInAppBrowser,
} from "#/features/attribution/sources";
import { ownLinkTags, tagOwnLinks, withUtm } from "#/features/attribution/utm";

const invite = "INV-ABCDEFGHJKLMNPQRSTUV";
const wechatUa =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47(0x18002f2c) NetType/WIFI Language/zh_CN";
const qqUa =
	"Mozilla/5.0 (Linux; Android 13; V2148A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/98.0.4758.102 MQQBrowser/6.2 TBS/046629 Mobile Safari/537.36 V1_AND_SQ_8.9.80_4614_YYB_D QQ/8.9.80.12440 NetType/WIFI";
const telegramAndroidUa =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 Telegram-Android/11.2.2 (Google Pixel 8; Android 14; SDK 34; AVERAGE)";
const safariUa =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

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

	it("splits direct visits by in-app browser and keeps referrers ahead of it", () => {
		expect(detectInAppBrowser(wechatUa)).toBe("wechat");
		expect(detectInAppBrowser(qqUa)).toBe("qq");
		expect(detectInAppBrowser(telegramAndroidUa)).toBe("telegram");
		expect(detectInAppBrowser(safariUa, true)).toBe("telegram");
		expect(detectInAppBrowser(safariUa)).toBeNull();
		expect(detectInAppBrowser(undefined)).toBeNull();
		expect(classifySource({ inApp: "wechat" })).toBe("wechat_in_app");
		expect(classifySource({ inApp: "telegram" })).toBe("telegram_in_app");
		expect(classifySource({ inApp: "qq" })).toBe("qq_in_app");
		expect(
			classifySource({ referrerHost: "www.zhihu.com", inApp: "wechat" }),
		).toBe("social");
		expect(classifySource({ utmSource: "newsletter", inApp: "qq" })).toBe(
			"other",
		);
	});

	it("treats invite links without campaign tags as referrals and our emails as email", () => {
		expect(classifySource({ invite: true })).toBe("referral");
		expect(
			classifySource({ invite: true, referrerHost: "www.zhihu.com" }),
		).toBe("referral");
		expect(classifySource({ invite: true, utmSource: "zhihu" })).toBe("social");
		expect(classifySource({ utmSource: "renewal", utmMedium: "email" })).toBe(
			"email",
		);
		// Webmail referrers (QQ Mail, Gmail) would otherwise read as social/search.
		expect(
			classifySource({
				referrerHost: "mail.qq.com",
				utmSource: "order_email",
				utmMedium: "Email",
			}),
		).toBe("email");
	});

	it("captures invite codes, in-app browsers and tags behind a sign-in redirect", () => {
		expect(
			captureFirstTouch({
				href: `https://laoshirenvip.com/?ref=${invite}`,
				referrer: "",
				now: 5,
				userAgent: wechatUa,
			}),
		).toEqual({ v: 1, p: "/", t: 5, i: "wechat", f: 1 });
		// Renewal links reuse `ref` for the stage; that is not an invite.
		expect(
			captureFirstTouch({
				href: "https://laoshirenvip.com/products/p?item=i&ref=renew_3d",
				referrer: "",
				now: 5,
			}).f,
		).toBeUndefined();
		expect(
			captureFirstTouch({
				href: `https://laoshirenvip.com/sign-in?redirect=${encodeURIComponent("/account?utm_source=renewal&utm_medium=email&utm_campaign=recall")}`,
				referrer: "",
				now: 6,
			}),
		).toEqual({
			v: 1,
			s: "renewal",
			m: "email",
			c: "recall",
			p: "/account",
			t: 6,
		});
		expect(
			captureFirstTouch({
				href: `https://laoshirenvip.com/sign-in?redirect=${encodeURIComponent("https://evil.example/?utm_source=x")}`,
				referrer: "",
				now: 6,
			}),
		).toEqual({ v: 1, p: "/sign-in", t: 6 });
	});

	it("updates last touch only for tagged, invited, external or first in-app landings", () => {
		const base = { v: 1 as const, p: "/", t: 9 };
		expect(lastTouchFrom(base, "laoshirenvip.com", true)).toBeNull();
		expect(
			lastTouchFrom({ ...base, s: "renewal" }, "laoshirenvip.com", false),
		).toEqual({ ...base, s: "renewal" });
		expect(lastTouchFrom({ ...base, f: 1 }, "laoshirenvip.com", false)).toEqual(
			{ ...base, f: 1 },
		);
		expect(
			lastTouchFrom({ ...base, r: "www.baidu.com" }, "laoshirenvip.com", false),
		).toEqual({ ...base, r: "www.baidu.com" });
		// Returning from checkout or our own subdomains is not a new touch.
		for (const host of [
			"mclient.alipay.com",
			"checkout.stripe.com",
			"redeem.laoshirenvip.com",
		])
			expect(
				lastTouchFrom({ ...base, r: host }, "www.laoshirenvip.com", true),
			).toBeNull();
		// A payment return is rejected outright, even in a fresh WeChat webview.
		expect(
			lastTouchFrom(
				{ ...base, r: "mclient.alipay.com", i: "wechat" },
				"laoshirenvip.com",
				true,
			),
		).toBeNull();
		expect(
			lastTouchFrom(
				{ ...base, r: "checkout.stripe.com", s: "renewal" },
				"laoshirenvip.com",
				false,
			),
		).toBeNull();
		// An untagged order page is a checkout return, not a new touch…
		expect(
			lastTouchFrom(
				{ ...base, p: "/orders/GM1", i: "wechat" },
				"laoshirenvip.com",
				true,
			),
		).toBeNull();
		// …but a tagged order link from our email is.
		expect(
			lastTouchFrom(
				{ ...base, p: "/account/orders/GM1", s: "order_email" },
				"laoshirenvip.com",
				false,
			),
		).toEqual({ ...base, p: "/account/orders/GM1", s: "order_email" });
		// In-app alone never replaces a last touch with tags, invite or referrer.
		for (const existing of [
			{ ...base, s: "renewal", m: "email" },
			{ ...base, f: 1 as const },
			{ ...base, r: "www.zhihu.com" },
		])
			expect(
				lastTouchFrom(
					{ ...base, i: "wechat" },
					"laoshirenvip.com",
					true,
					existing,
				),
			).toBeNull();
		expect(
			lastTouchFrom({ ...base, i: "wechat" }, "laoshirenvip.com", true, {
				...base,
				i: "qq",
			}),
		).toEqual({ ...base, i: "wechat" });
		expect(
			lastTouchFrom({ ...base, i: "wechat" }, "laoshirenvip.com", true),
		).toEqual({ ...base, i: "wechat" });
		expect(
			lastTouchFrom({ ...base, i: "wechat" }, "laoshirenvip.com", false),
		).toBeNull();
	});

	it("parses the last-touch cookie and ignores unknown in-app values", () => {
		const value = encodeURIComponent(
			JSON.stringify({ v: 1, s: "renewal", p: "/", t: 5, i: "line", f: 1 }),
		);
		expect(parseLastTouchCookie(`gmshop_lt=${value}`)).toEqual({
			v: 1,
			s: "renewal",
			p: "/",
			t: 5,
			f: 1,
		});
		expect(parseLastTouchCookie(`gmshop_ft=${value}`)).toBeNull();
	});
});

describe("own link tags", () => {
	const tag = ownLinkTags.orderEmail("delivery_ready");

	it("appends utm before the fragment without touching existing parameters", () => {
		expect(
			withUtm(
				"https://laoshirenvip.com/products/a%20b?item=x+y&ref=renew_3d#purchase-options",
				tag,
			),
		).toBe(
			"https://laoshirenvip.com/products/a%20b?item=x+y&ref=renew_3d&utm_source=order_email&utm_medium=email&utm_campaign=delivery_ready#purchase-options",
		);
		expect(
			withUtm("https://laoshirenvip.com/#support", ownLinkTags.supportReply),
		).toBe(
			"https://laoshirenvip.com/?utm_source=support&utm_medium=email&utm_campaign=support_reply#support",
		);
		expect(withUtm("/account", ownLinkTags.telegramBot("miniapp_shop"))).toBe(
			"/account?utm_source=telegram&utm_medium=bot&utm_campaign=miniapp_shop",
		);
		const alreadyTagged =
			"https://laoshirenvip.com/ip-check?utm_source=ip_share";
		expect(withUtm(alreadyTagged, tag)).toBe(alreadyTagged);
		expect(withUtm("not a url", tag)).toBe("not a url");
	});

	it("tags only links to our own host in text and HTML", () => {
		const announce = ownLinkTags.announcement("claude-launch");
		expect(
			tagOwnLinks(
				"看这里 https://laoshirenvip.com/products/claude。还有 https://www.laoshirenvip.com/?a=1, 以及 https://redeem.laoshirenvip.com/x 和 https://laoshirenvip.com.evil.example/ 和 https://example.com/ 退订：{{unsubscribe_url}}",
				"https://laoshirenvip.com",
				announce,
			),
		).toBe(
			"看这里 https://laoshirenvip.com/products/claude?utm_source=announcement&utm_medium=email&utm_campaign=claude-launch。还有 https://www.laoshirenvip.com/?a=1&utm_source=announcement&utm_medium=email&utm_campaign=claude-launch, 以及 https://redeem.laoshirenvip.com/x 和 https://laoshirenvip.com.evil.example/ 和 https://example.com/ 退订：{{unsubscribe_url}}",
		);
		expect(
			tagOwnLinks(
				'<a href="https://laoshirenvip.com/products/x?item=1&amp;y=2#buy">买</a> <a href="{{unsubscribe_url}}">退订</a>',
				"https://laoshirenvip.com",
				announce,
				"html",
			),
		).toBe(
			'<a href="https://laoshirenvip.com/products/x?item=1&amp;y=2&amp;utm_source=announcement&amp;utm_medium=email&amp;utm_campaign=claude-launch#buy">买</a> <a href="{{unsubscribe_url}}">退订</a>',
		);
	});
});
