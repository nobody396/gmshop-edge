import { describe, expect, it } from "vitest";
import {
	groupPlans,
	warrantyPeriodDays,
} from "#/features/storefront/pages/product";

const item = (name: string) => ({ id: name, name }) as never;

describe("groupPlans", () => {
	it("groups channels under their plan and drops the shared brand word", () => {
		const groups = groupPlans([
			item("ChatGPT Go｜1个月"),
			item("ChatGPT Plus｜菲区｜1个月"),
			item("ChatGPT Plus｜iOS｜1个月"),
			item("ChatGPT Pro 200｜菲区续费｜1个月"),
			item("ChatGPT Business｜2 个标准席位｜1个月"),
		]);
		expect(
			groups?.map((group) => [group.label, group.options.map((o) => o.label)]),
		).toEqual([
			["Go", ["1个月"]],
			["Plus", ["菲区", "iOS"]],
			["Pro 200", ["菲区续费"]],
			["Business", ["2 个标准席位"]],
		]);
	});

	it("keeps the flat grid when nothing would merge", () => {
		expect(
			groupPlans([item("Claude 算力卡｜¥50"), item("Claude 算力卡 Max｜¥100")]),
		).toBeNull();
	});
});

describe("warrantyPeriodDays", () => {
	it("reads the warranty period only when the policy states one", () => {
		expect(warrantyPeriodDays("质保30天订阅；掉订阅按实际使用天数处理")).toBe(
			30,
		);
		expect(warrantyPeriodDays("质保 3 天：收到后 3 天内登录不上免费换号")).toBe(
			3,
		);
		expect(warrantyPeriodDays("30-day subscription warranty")).toBe(30);
		expect(
			warrantyPeriodDays("2 分钟收不到验证码可在兑换页免费换号一次"),
		).toBeNull();
		expect(warrantyPeriodDays("")).toBeNull();
		expect(warrantyPeriodDays(undefined)).toBeNull();
	});
});
