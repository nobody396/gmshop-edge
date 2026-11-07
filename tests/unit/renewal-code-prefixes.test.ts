import { describe, expect, it } from "vitest";
import {
	extractWarehouseCodes,
	normalizeRedeemCode,
	redeemCodePrefixes,
} from "#/features/renewals/domain";

describe("renewal warehouse code extraction", () => {
	it.each(redeemCodePrefixes)("recognizes %s codes", (prefix) => {
		const code = `${prefix}-abcd-efgh-jklm-npqr`;
		expect(
			extractWarehouseCodes(`卡密：${code.toUpperCase()}\n兑换地址：x`),
		).toEqual([code]);
	});

	it("keeps a prefix that extends a shorter one whole", () => {
		expect(
			extractWarehouseCodes(
				"x-plus-1y-ABCD-EFGH-JKLM-NPQR / gpt-500-ph-GXUD-5AS9-FM2M-G2TN",
			),
		).toEqual([
			"x-plus-1y-abcd-efgh-jklm-npqr",
			"gpt-500-ph-gxud-5as9-fm2m-g2tn",
		]);
	});

	it("ignores partial codes and falls back to the whole text", () => {
		expect(extractWarehouseCodes("gpt-500-ph-ABCD-EFGH")).toEqual([]);
		expect(normalizeRedeemCode("  Some-Secret  ")).toBe("some-secret");
	});

	it("matches repeatedly despite the global flag", () => {
		const text = "gpt-500-chile-ABCD-EFGH-JKLM-NPQR";
		expect(extractWarehouseCodes(text)).toEqual(extractWarehouseCodes(text));
	});
});

describe("live catalog prefixes", () => {
	const unknown = "gpt-999-zz-ABCD-EFGH-JKLM-NPQR";

	it("recognizes a prefix only the live list knows", () => {
		expect(extractWarehouseCodes(unknown)).toEqual([]);
		expect(
			extractWarehouseCodes(unknown, [...redeemCodePrefixes, "gpt-999-zz"]),
		).toEqual([unknown.toLowerCase()]);
	});

	it("ignores malformed prefixes instead of building a broken pattern", () => {
		expect(
			extractWarehouseCodes(unknown, [...redeemCodePrefixes, "a|b", "(x"]),
		).toEqual([]);
		expect(
			extractWarehouseCodes("gpt-plus-ph-ABCD-EFGH-JKLM-NPQR", [
				...redeemCodePrefixes,
				"a|b",
			]),
		).toEqual(["gpt-plus-ph-abcd-efgh-jklm-npqr"]);
	});
});
