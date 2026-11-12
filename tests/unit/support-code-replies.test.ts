import { describe, expect, it } from "vitest";
import {
	matchSupportCodeReply,
	parseSupportCodeReplyRules,
} from "#/features/telegram/server/support-code-replies";

const rules = parseSupportCodeReplyRules(
	JSON.stringify([
		{
			prefixes: ["claude-pro-acct-", "claude-5x-acct-", "claude-20x-acct-"],
			message: "已收到你的 Claude 成品号预定码",
		},
	]),
);

describe("support code auto replies", () => {
	it("matches a pasted reservation code anywhere in the message", () => {
		expect(
			matchSupportCodeReply(
				rules,
				"请把这一整段复制，发给网站右下角的在线客服：Claude Max 20X 成品号预定码 claude-20x-acct-ABCD-EFGH-JKLM",
			),
		).toEqual({ index: 0, message: "已收到你的 Claude 成品号预定码" });
		expect(matchSupportCodeReply(rules, "CLAUDE-PRO-ACCT-AAAA")).not.toBeNull();
	});

	it("ignores unrelated text", () => {
		expect(matchSupportCodeReply(rules, "你好，在吗")).toBeNull();
	});

	it("disables replies when the stored setting is invalid", () => {
		expect(parseSupportCodeReplyRules("not json")).toEqual([]);
		expect(
			parseSupportCodeReplyRules('[{"prefixes":[],"message":"x"}]'),
		).toEqual([]);
		expect(parseSupportCodeReplyRules(null)).toEqual([]);
	});
});
